const express = require("express");
const cors = require("cors");
require("dotenv").config();
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const stripe = require("stripe")(process.env.STRIPE_SECRET);
const crypto = require("crypto");
const port = process.env.PORT || 3000;
const app = express();

function generateTrackingId() {
  const prefix = "TRK";
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const randomString = crypto.randomBytes(3).toString("hex").toUpperCase();

  return `${prefix}-${date}-${randomString}`;
}

// middleware
app.use(cors());
app.use(express.json());

// mongodb
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASSWORD}@cluster0.jd5uu0i.mongodb.net/?appName=Cluster0`;
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

const database = client.db("stitchFlow_db");
const usersCollection = database.collection("users");
const productsCollection = database.collection("products");
const ordersCollection = database.collection("orders");
const trackingCollection = database.collection("trackings");

let cachedClient = null;

async function connectToDatabase() {
  if (cachedClient) {
    return cachedClient;
  }
  await client.connect();
  cachedClient = client;
  console.log("MongoDB database connected");
  return cachedClient;
}

app.get("/", (req, res) => {
  res.send("StitchFlow server is running");
});

app.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    message: "StitchFlow API is running",
  });
});

// users related apis
app.post("/users", async (req, res) => {
  try {
    await connectToDatabase();
    const user = req.body;
    user.role = "buyer";
    user.createdAt = new Date();
    const email = user.email;
    const existingUser = await usersCollection.findOne({ email });

    if (existingUser) {
      return res.send({ message: "User already exists" });
    }

    const result = await usersCollection.insertOne(user);
    res.send(user);
  } catch (error) {
    res.status(500).send({ message: error.message });
  }
});

// products related apis
app.post("/products", async (req, res) => {
  try {
    await connectToDatabase();

    const product = req.body;
    product.createdAt = new Date();

    const result = await productsCollection.insertOne(product);

    res.status(201).send(result);
  } catch (error) {
    res.status(500).send({ message: error.message });
  }
});

app.get("/products", async (req, res) => {
  try {
    await connectToDatabase();

    const search = req.query.search || "";
    const page = parseInt(req.query.page);
    const limit = parseInt(req.query.limit);
    const skip = (page - 1) * limit;

    // Case-insensitive regex search query across product fields
    const query = search
      ? {
          $or: [
            { productName: { $regex: search, $options: "i" } },
            { category: { $regex: search, $options: "i" } },
            { description: { $regex: search, $options: "i" } },
          ],
        }
      : {};

    // Get total count of matching products for frontend pagination
    const totalProducts = await productsCollection.countDocuments(query);

    // Fetch the paginated slice of products
    const products = await productsCollection
      .find(query)
      .skip(skip)
      .limit(limit)
      .toArray();

    res.send({
      products,
      totalProducts,
      totalPages: Math.ceil(totalProducts / limit),
      currentPage: page,
    });
  } catch (error) {
    res.status(500).send({ message: error.message });
  }
});

app.get("/products/our-products", async (req, res) => {
  try {
    await connectToDatabase();

    const limit = Number(req.query.limit) || 6;

    const cursor = productsCollection
      .find()
      .sort({ createdAt: -1 })
      .limit(limit);
    const result = await cursor.toArray();
    res.send(result);
  } catch (error) {
    res.status(500).send({ message: error.message });
  }
});

app.get("/products/:id", async (req, res) => {
  try {
    await connectToDatabase();

    const id = req.params.id;
    const query = { _id: new ObjectId(id) };
    const result = await productsCollection.findOne(query);
    res.send(result);
  } catch (error) {
    res.status(500).send({ message: error.message });
  }
});

// payment related apis
app.post("/payment-checkout-session", async (req, res) => {
  try {
  } catch (error) {
    console.error(error);
    res.status(500).send({ message: error.message });
  }
});

// orders related api
app.post("/orders", async (req, res) => {
  try {
    await connectToDatabase();

    const {
      productId,
      quantity,
      customerEmail,
      firstName,
      lastName,
      contactNumber,
      deliveryAddress,
      additionalNotes,
      paymentMethod,
    } = req.body;

    // ================= VALIDATION =================

    if (
      !productId ||
      !quantity ||
      !customerEmail || // 2. Ensure email is provided
      !firstName ||
      !lastName ||
      !contactNumber ||
      !deliveryAddress
    ) {
      return res.status(400).send({
        message: "Required fields are missing",
      });
    }

    // ================= FIND PRODUCT =================

    const product = await productsCollection.findOne({
      _id: new ObjectId(productId),
    });

    if (!product) {
      return res.status(404).send({
        message: "Product not found",
      });
    }

    // ================= QUANTITY VALIDATION =================

    const orderQuantity = Number(quantity);

    if (
      !Number.isInteger(orderQuantity) ||
      orderQuantity <= 0 ||
      orderQuantity < Number(product.minimumOrder) ||
      orderQuantity > Number(product.availableQuantity)
    ) {
      return res.status(400).send({
        message:
          "Invalid order quantity or exceeds available stock/minimum requirement",
      });
    }

    // ================= PAYMENT VALIDATION =================

    if (
      product.paymentOptions &&
      !product.paymentOptions.includes(paymentMethod)
    ) {
      return res.status(400).send({
        message: "Selected payment method is not available",
      });
    }

    // ================= PRICE =================

    const unitPrice = Number(product.price);

    if (!Number.isFinite(unitPrice) || unitPrice < 0) {
      return res.status(400).send({
        message: "Invalid product price",
      });
    }

    const totalPrice = unitPrice * orderQuantity;

    // ================= TRACKING ID =================

    const trackingId = generateTrackingId();

    // ================= CREATE ORDER =================

    const newOrder = {
      trackingId,

      productId: product._id,
      productTitle: product.productName,
      productImage: product.images?.[0] || "",

      unitPrice,
      quantity: orderQuantity,
      totalPrice,
      currency: product.currency || "BDT",

      customerEmail,

      firstName: firstName.trim(),
      lastName: lastName.trim(),
      contactNumber: contactNumber.trim(),
      deliveryAddress: deliveryAddress.trim(),
      additionalNotes: additionalNotes?.trim() || "",

      paymentMethod,
      paymentStatus: "pending",

      orderStatus: "pending-review",

      productionStage: "not-started",

      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const orderResult = await ordersCollection.insertOne(newOrder);

    // ================= FIRST TRACKING RECORD =================

    const trackingRecord = {
      orderId: orderResult.insertedId,

      trackingId,

      status: "pending-review",

      details:
        "Order submitted successfully and is waiting for manager review.",

      createdAt: new Date(),
    };

    await trackingCollection.insertOne(trackingRecord);

    // ================= RESPONSE =================

    res.status(201).send({
      success: true,
      message:
        "Order submitted successfully. Waiting for manager review.",

      orderId: orderResult.insertedId,
      trackingId,
    });
  } catch (error) {
    console.error("Order creation error:", error);

    res.status(500).send({
      success: false,
      message: "Failed to create order",
    });
  }
});

if (process.env.NODE_ENV !== "production") {
  app.listen(port, () => {
    console.log(`StitchFlow Server running on port ${port}`);
  });
}
