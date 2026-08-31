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

// ** admin only
app.get("/dashboard/admin-stats", async (req, res) => {
  try {
    await connectToDatabase();

    // Make sure your verifyToken adds email to req.user
    const admin = await usersCollection.findOne({
      email: req.query.email,
    });

    if (!admin || admin.role !== "admin") {
      return res.status(403).send({
        message: "Forbidden. Admin access required.",
      });
    }

    const [
      totalUsers,
      totalProducts,
      totalOrders,
      totalTrackings,

      pendingOrders,
      approvedOrders,
      rejectedOrders,
      completedOrders,

      paidOrders,
      unpaidOrders,

      revenueResult,
      orderStatusResult,
      userRoleResult,
      monthlyOrdersResult,

      recentOrders,
      recentProducts,
      recentTrackings,
    ] = await Promise.all([
      usersCollection.countDocuments(),

      productsCollection.countDocuments(),

      ordersCollection.countDocuments(),

      trackingCollection.countDocuments(),

      ordersCollection.countDocuments({
        orderStatus: "pending-review",
      }),

      ordersCollection.countDocuments({
        orderStatus: "approved",
      }),

      ordersCollection.countDocuments({
        orderStatus: "rejected",
      }),

      ordersCollection.countDocuments({
        orderStatus: "completed",
      }),

      ordersCollection.countDocuments({
        paymentStatus: "paid",
      }),

      ordersCollection.countDocuments({
        paymentStatus: {
          $ne: "paid",
        },
      }),

      ordersCollection
        .aggregate([
          {
            $match: {
              paymentStatus: "paid",
            },
          },
          {
            $group: {
              _id: null,
              total: {
                $sum: {
                  $toDouble: "$totalPrice",
                },
              },
            },
          },
        ])
        .toArray(),

      ordersCollection
        .aggregate([
          {
            $group: {
              _id: "$orderStatus",
              count: {
                $sum: 1,
              },
            },
          },
          {
            $sort: {
              count: -1,
            },
          },
        ])
        .toArray(),

      usersCollection
        .aggregate([
          {
            $group: {
              _id: "$role",
              count: {
                $sum: 1,
              },
            },
          },
          {
            $sort: {
              count: -1,
            },
          },
        ])
        .toArray(),

      ordersCollection
        .aggregate([
          {
            $match: {
              createdAt: {
                $gte: new Date(
                  new Date().getFullYear(),
                  new Date().getMonth() - 5,
                  1,
                ),
              },
            },
          },
          {
            $group: {
              _id: {
                year: {
                  $year: "$createdAt",
                },
                month: {
                  $month: "$createdAt",
                },
              },
              orders: {
                $sum: 1,
              },
            },
          },
          {
            $sort: {
              "_id.year": 1,
              "_id.month": 1,
            },
          },
        ])
        .toArray(),

      ordersCollection
        .find({})
        .sort({
          createdAt: -1,
        })
        .limit(6)
        .toArray(),

      productsCollection
        .find({})
        .sort({
          createdAt: -1,
        })
        .limit(5)
        .toArray(),

      trackingCollection
        .find({})
        .sort({
          createdAt: -1,
        })
        .limit(5)
        .toArray(),
    ]);

    const totalRevenue = revenueResult[0]?.total || 0;

    const usersByRole = {
      buyer: 0,
      manager: 0,
      admin: 0,
    };

    userRoleResult.forEach((item) => {
      usersByRole[item._id] = item.count;
    });

    const monthlyOrders = monthlyOrdersResult.map((item) => ({
      month: `${item._id.year}-${String(item._id.month).padStart(2, "0")}`,
      orders: item.orders,
    }));

    res.send({
      stats: {
        totalUsers,
        totalProducts,
        totalOrders,
        totalTrackings,

        pendingOrders,
        approvedOrders,
        rejectedOrders,
        completedOrders,

        paidOrders,
        unpaidOrders,

        totalRevenue,
      },

      usersByRole,

      orderStatus: orderStatusResult.map((item) => ({
        status: item._id,
        count: item.count,
      })),

      monthlyOrders,

      recentOrders,
      recentProducts,
      recentTrackings,
    });
  } catch (error) {
    console.error("Admin dashboard error:", error);

    res.status(500).send({
      message: "Failed to load admin dashboard",
    });
  }
});


// manager only
app.get("/manager/dashboard", async (req, res) => {
  try {
    await connectToDatabase();

    const totalProducts = await productsCollection.countDocuments();

    const totalOrders = await ordersCollection.countDocuments();

    const pendingOrders = await ordersCollection.countDocuments({
      orderStatus: "pending-review",
    });

    const approvedOrders = await ordersCollection.countDocuments({
      orderStatus: "approved",
    });

    const rejectedOrders = await ordersCollection.countDocuments({
      orderStatus: "rejected",
    });

    const recentOrders = await ordersCollection
      .find({})
      .sort({ createdAt: -1 })
      .limit(5)
      .toArray();

    res.send({
      totalProducts,
      totalOrders,
      pendingOrders,
      approvedOrders,
      rejectedOrders,
      recentOrders,
    });
  } catch (error) {
    res.status(500).send({
      message: error.message,
    });
  }
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

app.get("/users/:email/role", async (req, res) => {
  try {
    await connectToDatabase();

    const email = req.params.email;
    const query = { email };
    const result = await usersCollection.findOne(query);

    res.send({ role: result?.role || "buyer" });
  } catch (error) {
    res.status(500).send({ message: error.message });
  }
});

app.get("/users", async (req, res) => {
  try {
    await connectToDatabase();

    const search = req.query.search || "";

    const users = await usersCollection
      .find({
        $or: [
          {
            displayName: {
              $regex: search,
              $options: "i",
            },
          },
          {
            email: {
              $regex: search,
              $options: "i",
            },
          },
        ],
      })
      .sort({ createdAt: -1 })
      .toArray();

    res.send(users);
  } catch (error) {
    console.log(error);
    res.status(500).send({
      message: "Failed to get users",
    });
  }
});

app.patch("/users/:id", async (req, res) => {
  try {
    await connectToDatabase();

    const id = req.params.id;

    const { role, status } = req.body;

    const updateData = {};

    if (role) {
      updateData.role = role;
    }

    if (status) {
      updateData.status = status;
    }

    const result = await usersCollection.updateOne(
      {
        _id: new ObjectId(id),
      },
      {
        $set: updateData,
      },
    );

    res.send(result);
  } catch (error) {
    console.log(error);

    res.status(500).send({
      message: "Failed to update user",
    });
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
      .find({ showOnHome: true })
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

app.patch("/products/home/:id", async (req, res) => {
  const id = req.params.id;
  const { showOnHome } = req.body;

  const result = await productsCollection.updateOne(
    { _id: new ObjectId(id) },
    {
      $set: {
        showOnHome,
      },
    },
  );

  res.send(result);
});

app.patch("/products/:id", async (req, res) => {
  try {
    await connectToDatabase();

    const id = req.params.id;

    const {
      productName,
      description,
      category,
      price,
      availableQuantity,
      minimumOrder,
      images,
      demoVideo,
      paymentOptions,
    } = req.body;

    const query = { _id: new ObjectId(id) };

    const updateData = {
      productName,
      description,
      category,
      price: Number(price),
      availableQuantity: Number(availableQuantity),
      minimumOrder: Number(minimumOrder),
      images,
      demoVideo,
      paymentOptions,
      updatedAt: new Date(),
    };

    const result = await productsCollection.updateOne(query, {
      $set: updateData,
    });

    res.send(result);
  } catch (error) {
    console.error(error);
    res.status(500).send({
      message: error.message,
    });
  }
});

app.delete("/products/:id", async (req, res) => {
  try {
    await connectToDatabase();

    const id = req.params.id;
    const query = { _id: new ObjectId(id) };
    const result = await productsCollection.deleteOne(query);
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
      message: "Order submitted successfully. Waiting for manager review.",

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

app.get("/orders", async (req, res) => {
  try {
    await connectToDatabase();

    const result = await ordersCollection.find().toArray();
    res.send(result);
  } catch (error) {
    res.status(500).send({ message: error.message });
  }
});

app.get("/orders/:id", async (req, res) => {
  try {
    await connectToDatabase();

    const id = req.params.id;
    const query = { _id: new ObjectId(id) };
    const order = await ordersCollection.findOne(query);

    if (!order) {
      return res.status(404).send({ message: "Order not found " });
    }

    res.send(order);
  } catch (error) {
    res.status(500).send({ message: error.message });
  }
});

// Trackings related apis
app.get("/trackings/:trackingId", async (req, res) => {
  try {
    await connectToDatabase();

    const trackingId = req.params.trackingId;

    const trackings = await trackingCollection
      .find({ trackingId })
      .sort({ createdAt: 1 })
      .toArray();

    res.send(trackings);
  } catch (error) {
    res.status(500).send({
      message: error.message,
    });
  }
});

if (process.env.NODE_ENV !== "production") {
  app.listen(port, () => {
    console.log(`StitchFlow Server running on port ${port}`);
  });
}
