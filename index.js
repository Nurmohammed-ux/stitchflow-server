const express = require("express");
const cors = require("cors");
require("dotenv").config();
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const stripe = require("stripe")(process.env.STRIPE_SECRET);
const crypto = require("crypto");
const port = process.env.PORT || 3000;
const app = express();
const { initializeApp, cert } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");

try {
  const serviceAccount = require("./stitchflow-client-firebase-adminkey.json");

  initializeApp({
    credential: cert(serviceAccount),
  });
  console.log("Firebase initialized");
} catch (err) {
  console.error("Firebase initialization error:", err);
}

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
const paymentCollection = database.collection("payments");

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

//Jwt middleware
const verifyFirebaseToken = async (req, res, next) => {
  try {
    await connectToDatabase();
    const authorization = req.headers.authorization;

    if (!authorization || !authorization.startsWith("Bearer ")) {
      return res
        .status(401)
        .send({ message: "Unauthorized Access: No token provided" });
    }

    const token = authorization.split(" ")[1];

    const decoded = await getAuth().verifyIdToken(token);
    req.token_email = decoded.email;
    next();
  } catch (err) {
    console.error("Token verification error:", err.message);
    return res.status(401).send({
      message: "Invalid token",
      error: err.message,
    });
  }
};

app.get("/", (req, res) => {
  res.send("StitchFlow server is running");
});

app.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    message: "StitchFlow API is running",
  });
});

// ** admin dashboard statistics
app.get("/dashboard/admin-stats", async (req, res) => {
  try {
    await connectToDatabase();

    const admin = await usersCollection.findOne({
      email: req.query.email,
    });

    if (!admin || admin.role !== "admin") {
      return res.status(403).send({
        message: "Forbidden. Admin access required.",
      });
    }

    // 1. Fetch collections concurrently, including all tracking data
    const [
      totalUsers,
      totalProducts,
      totalOrders,
      totalTrackings,
      orders,
      trackings,
      userRoleResult,
      monthlyOrdersResult,
      recentProducts,
      recentTrackings,
    ] = await Promise.all([
      usersCollection.countDocuments(),
      productsCollection.countDocuments(),
      ordersCollection.countDocuments(),
      trackingCollection.countDocuments(),
      ordersCollection.find({}).toArray(),
      trackingCollection.find({}).sort({ createdAt: -1 }).toArray(),

      usersCollection
        .aggregate([
          { $group: { _id: "$role", count: { $sum: 1 } } },
          { $sort: { count: -1 } },
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
                year: { $year: "$createdAt" },
                month: { $month: "$createdAt" },
              },
              orders: { $sum: 1 },
            },
          },
          { $sort: { "_id.year": 1, "_id.month": 1 } },
        ])
        .toArray(),

      productsCollection.find({}).sort({ createdAt: -1 }).limit(5).toArray(),
      trackingCollection.find({}).sort({ createdAt: -1 }).limit(5).toArray(),
    ]);

    // 2. Build a tracking status map for quick resolution
    const trackingMap = new Map();
    trackings.forEach((t) => {
      trackingMap.set(t.trackingId, t.status);
    });

    // 3. Enrich orders with tracking status and determine effective status
    const enrichedOrders = orders.map((o) => {
      const trackingStatus = trackingMap.get(o.trackingId) || null;
      // If tracking status is approved, override/treat effective status as approved
      const effectiveStatus =
        trackingStatus === "approved" ? "approved" : o.orderStatus;

      return {
        ...o,
        trackingStatus,
        effectiveStatus,
      };
    });

    // 4. Calculate metrics based on effective status
    const pendingOrders = enrichedOrders.filter(
      (o) => o.effectiveStatus === "pending-review",
    ).length;

    const approvedOrders = enrichedOrders.filter(
      (o) => o.effectiveStatus === "approved",
    ).length;

    const rejectedOrders = enrichedOrders.filter(
      (o) => o.effectiveStatus === "rejected",
    ).length;

    const completedOrders = enrichedOrders.filter(
      (o) => o.effectiveStatus === "completed",
    ).length;

    const paidOrders = enrichedOrders.filter(
      (o) => o.paymentStatus === "paid",
    ).length;

    const unpaidOrders = totalOrders - paidOrders;

    const totalRevenue = enrichedOrders
      .filter((o) => o.paymentStatus === "paid")
      .reduce((sum, o) => sum + Number(o.totalPrice || 0), 0);

    // 5. Generate dynamic order status distribution for charts
    const statusCounts = {};
    enrichedOrders.forEach((o) => {
      const status = o.effectiveStatus || "unknown";
      statusCounts[status] = (statusCounts[status] || 0) + 1;
    });

    const orderStatusResult = Object.entries(statusCounts)
      .map(([status, count]) => ({ status, count }))
      .sort((a, b) => b.count - a.count);

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

    const recentOrders = enrichedOrders
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, 6);

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
      orderStatus: orderStatusResult,
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

// ** manager dashboard statistics
app.get("/manager/dashboard", async (req, res) => {
  try {
    await connectToDatabase();

    const [totalProducts, orders, trackings] = await Promise.all([
      productsCollection.countDocuments(),
      ordersCollection.find({}).toArray(),
      trackingCollection.find({}).toArray(),
    ]);

    const totalOrders = orders.length;

    // Map tracking statuses
    const trackingMap = new Map();
    trackings.forEach((t) => {
      trackingMap.set(t.trackingId, t.status);
    });

    // Enrich and compute effective status
    const enrichedOrders = orders.map((o) => {
      const trackingStatus = trackingMap.get(o.trackingId) || null;
      const effectiveStatus =
        trackingStatus === "approved" ? "approved" : o.orderStatus;
      return { ...o, trackingStatus, effectiveStatus };
    });

    const pendingOrders = enrichedOrders.filter(
      (o) => o.effectiveStatus === "pending-review",
    ).length;

    const approvedOrders = enrichedOrders.filter(
      (o) => o.effectiveStatus === "approved",
    ).length;

    const rejectedOrders = enrichedOrders.filter(
      (o) => o.effectiveStatus === "rejected",
    ).length;

    const recentOrders = enrichedOrders
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, 5);

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
// Get buyer dashboard statistics
app.get("/dashboard/buyer-stats", verifyFirebaseToken, async (req, res) => {
  try {
    await connectToDatabase();
    const email = req.query.email;

    if (!email || email !== req.token_email) {
      return res.status(403).send({ message: "Forbidden access" });
    }

    // 1. Fetch user orders and tracking documents concurrently
    const orders = await ordersCollection
      .find({ customerEmail: email })
      .toArray();

    const trackingIds = orders.map((o) => o.trackingId).filter(Boolean);

    const trackings = await trackingCollection
      .find({ trackingId: { $in: trackingIds } })
      .toArray();

    // Create a lookup map for fast tracking status retrieval
    const trackingMap = new Map();
    trackings.forEach((t) => {
      trackingMap.set(t.trackingId, t.status);
    });

    // 2. Attach tracking status to each order object
    const enrichedOrders = orders.map((o) => ({
      ...o,
      trackingStatus: trackingMap.get(o.trackingId) || null,
    }));

    const totalOrders = enrichedOrders.length;

    // Check approval via tracking collection status OR approvedAt date/orderStatus
    const pendingOrders = enrichedOrders.filter(
      (o) =>
        o.orderStatus === "pending-review" && o.trackingStatus !== "approved",
    ).length;

    const approvedOrders = enrichedOrders.filter(
      (o) =>
        o.trackingStatus === "approved" ||
        o.orderStatus === "approved" ||
        o.approvedAt,
    ).length;

    const rejectedOrders = enrichedOrders.filter(
      (o) => o.orderStatus === "rejected" || o.trackingStatus === "rejected",
    ).length;

    const completedOrders = enrichedOrders.filter(
      (o) => o.orderStatus === "completed" || o.trackingStatus === "completed",
    ).length;

    const paidOrders = enrichedOrders.filter(
      (o) => o.paymentStatus === "paid",
    ).length;
    const unpaidOrders = totalOrders - paidOrders;

    const totalSpent = enrichedOrders
      .filter((o) => o.paymentStatus === "paid")
      .reduce((sum, o) => sum + Number(o.totalPrice || 0), 0);

    // 3. Format order status data for the PieChart
    const orderStatus = [
      { status: "pending", count: pendingOrders },
      { status: "approved", count: approvedOrders },
      { status: "rejected", count: rejectedOrders },
      { status: "completed", count: completedOrders },
    ].filter((item) => item.count > 0);

    // 4. Format recent orders (including trackingStatus if needed on frontend)
    const recentOrders = enrichedOrders
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, 5);

    // 5. Active order lookup based on tracking status or approved state
    const activeOrder = enrichedOrders.find(
      (o) =>
        (o.trackingStatus === "approved" || o.orderStatus === "approved") &&
        o.productionStage !== "delivered",
    );

    res.send({
      stats: {
        totalOrders,
        pendingOrders,
        approvedOrders,
        rejectedOrders,
        completedOrders,
        paidOrders,
        unpaidOrders,
        totalSpent,
      },
      orderStatus,
      recentOrders,
      activeOrder: activeOrder || null,
    });
  } catch (error) {
    console.error("Stats error:", error);
    res.status(500).send({ message: error.message });
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

// manager manage product
app.get("/products/manager", async (req, res) => {
  try {
    await connectToDatabase();

    const email = req.query.email;
    const search = req.query.search || "";

    // Guard clause: Prevent MongoDB casting errors if email is missing
    if (!email) {
      return res
        .status(400)
        .json({ message: "Email query parameter is required." });
    }

    const products = await productsCollection
      .find({
        createdBy: email,
        $or: [
          {
            productName: {
              $regex: search,
              $options: "i",
            },
          },
          {
            category: {
              $regex: search,
              $options: "i",
            },
          },
        ],
      })
      .sort({ createdAt: -1 })
      .toArray();

    res.send(products);
  } catch (error) {
    res.status(500).json({ message: error.message });
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

// =====================================================
// TRACKING HELPER FUNCTION
// =====================================================
async function logTracking(trackingId, status, details = "") {
  try {
    // Find the order first to get its orderId if needed
    const order = await ordersCollection.findOne({ trackingId });

    const trackingRecord = {
      orderId: order ? order._id : null,
      trackingId,
      status,
      details: details || `Order status updated to: ${status}`,
      createdAt: new Date(),
    };

    await trackingCollection.insertOne(trackingRecord);
  } catch (error) {
    console.error("Error logging tracking:", error);
  }
}

// payment related apis
app.post("/payment-checkout-session", async (req, res) => {
  try {
    const orderInfo = req.body;
    const amount = parseInt(orderInfo.cost) * 100;

    const session = await stripe.checkout.sessions.create({
      line_items: [
        {
          price_data: {
            currency: "BDT",
            unit_amount: amount,
            product_data: {
              name: `Please, pay for ${orderInfo.orderName}`,
            },
          },
          quantity: 1,
        },
      ],
      customer_email: orderInfo.customerEmail,
      mode: "payment",
      metadata: {
        orderId: orderInfo.orderId,
        orderName: orderInfo.orderName,
        trackingId: orderInfo.trackingId,
      },
      success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.SITE_DOMAIN}/dashboard/payment-cancelled`,
    });

    res.send({ url: session.url });
  } catch (error) {
    console.error(error);
    res.status(500).send({ message: error.message });
  }
});

app.patch("/payment-success", async (req, res) => {
  try {
    await connectToDatabase();

    const sessionId = req.query.session_id;

    if (!sessionId) {
      return res.status(400).send({
        message: "Session ID is required",
      });
    }

    // Get Stripe checkout session
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    // Make sure payment was actually completed
    if (session.payment_status !== "paid") {
      return res.send({
        success: false,
        message: "Payment not completed",
      });
    }

    // Order ID stored in Stripe metadata
    const orderId = session.metadata.orderId;

    if (!orderId) {
      return res.status(400).send({
        message: "Order ID not found in payment session",
      });
    }

    const query = {
      _id: new ObjectId(orderId),
    };

    // =====================================================
    // GET ORDER FIRST (Fixes scope/ReferenceError)
    // =====================================================

    const order = await ordersCollection.findOne(query);

    if (!order) {
      return res.status(404).send({
        message: "Order not found",
      });
    }

    const trackingId = order.trackingId;

    // Check whether this Stripe session was already processed
    const existingPayment = await paymentCollection.findOne({
      sessionId: session.id,
    });

    // =====================================================
    // PAYMENT ALREADY PROCESSED
    // =====================================================

    if (existingPayment) {
      return res.send({
        success: true,
        message: "Payment already processed",
        modifyOrder: null,
        orderId: order._id.toString(),
        trackingId,
        transactionId: session.payment_intent,
        paymentInfo: existingPayment,
      });
    }

    // =====================================================
    // UPDATE ORDER
    // =====================================================

    const update = {
      $set: {
        paymentStatus: "paid",
        transactionId: session.payment_intent,
        paidAt: new Date(),
        updatedAt: new Date(),
      },
    };

    const result = await ordersCollection.updateOne(query, update);

    // =====================================================
    // CREATE PAYMENT RECORD
    // =====================================================

    const paymentRecord = {
      orderId: order._id,
      transactionId: session.payment_intent,
      sessionId: session.id,
      amount: session.amount_total / 100,
      currency: session.currency,
      customerEmail: session.customer_details?.email || session.customer_email,
      paymentStatus: session.payment_status,
      paidAt: new Date(),
    };

    const resultPayment = await paymentCollection.insertOne(paymentRecord);

    // =====================================================
    // CREATE INITIAL TRACKING LOG
    // =====================================================

    await logTracking(
      trackingId,
      "payment-confirmed",
      "Payment successfully verified via Stripe.",
    );

    // =====================================================
    // RESPONSE
    // =====================================================

    return res.send({
      success: true,
      message: "Payment processed successfully",
      modifyOrder: result,
      trackingId,
      transactionId: session.payment_intent,
      paymentInfo: resultPayment,
    });
  } catch (error) {
    console.error("Payment success route error:", error);

    res.status(500).send({
      message: error.message,
    });
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

app.get("/orders/manager", async (req, res) => {
  try {
    await connectToDatabase();

    const orderStatus = req.query.orderStatus;
    let query = {};

    if (orderStatus) {
      if (orderStatus === "approved") {
        query.orderStatus = {
          $in: [
            "approved",
            "processing",
            "cutting-completed",
            "sewing-started",
            "finishing",
            "qc-checked",
            "packed",
            "shipped",
            "out-for-delivery",
            "in-transit",
          ],
        };
      } else {
        query = { orderStatus };
      }
    }

    const orders = await ordersCollection
      .find(query)
      .sort({ createdAt: -1 })
      .toArray();

    res.send(orders);
  } catch (error) {
    res.status(500).send({ message: error.message });
  }
});

// Get all orders of logged-in buyer
app.get("/orders/my-orders", verifyFirebaseToken, async (req, res) => {
  try {
    await connectToDatabase();

    const email = req.query.email;

    // Validate email
    if (!email) {
      return res.status(400).send({
        message: "Email is required",
      });
    }

    // Make sure buyer can only access their own orders
    if (email !== req.token_email) {
      return res.status(403).send({
        message: "Forbidden access",
      });
    }

    // --------------------------------------------------
    // 1. Get buyer's orders
    // --------------------------------------------------
    const orders = await ordersCollection
      .find({
        customerEmail: email,
      })
      .sort({
        createdAt: -1,
      })
      .toArray();

    // If buyer has no orders
    if (orders.length === 0) {
      return res.send([]);
    }

    // --------------------------------------------------
    // 2. Collect tracking IDs and order IDs
    // --------------------------------------------------
    const trackingIds = orders.map((order) => order.trackingId).filter(Boolean);

    const orderIds = orders.map((order) => order._id);

    // --------------------------------------------------
    // 3. Get tracking records
    // --------------------------------------------------
    const trackings = await trackingCollection
      .find({
        $or: [
          // Normal trackingId
          ...(trackingIds.length > 0
            ? [{ trackingId: { $in: trackingIds } }]
            : []),

          // In case some old records use "id"
          ...(trackingIds.length > 0 ? [{ id: { $in: trackingIds } }] : []),

          // In case some old records use "tracking_id"
          ...(trackingIds.length > 0
            ? [{ tracking_id: { $in: trackingIds } }]
            : []),

          // Normal orderId relationship
          ...(orderIds.length > 0 ? [{ orderId: { $in: orderIds } }] : []),
        ],
      })
      // Newest tracking status first
      .sort({
        createdAt: -1,
      })
      .toArray();

    // --------------------------------------------------
    // 4. Create tracking map
    // --------------------------------------------------
    //
    // Example:
    //
    // TRK-20260827-9834FF
    //      ↓
    // "cutting-completed"
    //
    // --------------------------------------------------

    const trackingMap = new Map();

    trackings.forEach((tracking) => {
      const trackingId =
        tracking.trackingId || tracking.id || tracking.tracking_id;

      const status = tracking.status ? tracking.status.toLowerCase() : "";

      // Map by trackingId
      if (trackingId && !trackingMap.has(trackingId)) {
        trackingMap.set(trackingId, status);
      }

      // Map by orderId
      if (tracking.orderId) {
        const orderId = tracking.orderId.toString();

        if (!trackingMap.has(orderId)) {
          trackingMap.set(orderId, status);
        }
      }
    });

    // --------------------------------------------------
    // 5. Enrich orders
    // --------------------------------------------------

    const enrichedOrders = orders.map((order) => {
      // Find latest tracking status
      const trackingStatus =
        trackingMap.get(order.trackingId) ||
        trackingMap.get(order._id.toString()) ||
        null;

      // ------------------------------------------------
      // ORDER STATUS
      // ------------------------------------------------
      //
      // Tracking statuses that mean the order has
      // already been approved.
      //
      const approvedStatuses = ["approved", "payment-confirmed"];

      const isApprovedByTracking = approvedStatuses.includes(trackingStatus);

      const effectiveOrderStatus = isApprovedByTracking
        ? "approved"
        : order.orderStatus;

      // ------------------------------------------------
      // PRODUCTION STAGE
      // ------------------------------------------------

      let effectiveProductionStage = order.productionStage || "not-started";

      const productionStatuses = [
        "cutting-completed",
        "sewing-started",
        "finishing",
        "qc-checked",
      ];

      if (productionStatuses.includes(trackingStatus)) {
        effectiveProductionStage = "in-production";
      }

      // ------------------------------------------------
      // PRODUCTION COMPLETED
      // ------------------------------------------------

      const completedStatuses = [
        "packed",
        "shipped",
        "out-for-delivery",
        "delivered",
      ];

      if (completedStatuses.includes(trackingStatus)) {
        effectiveProductionStage = "completed";
      }

      return {
        ...order,
        trackingStatus,
        orderStatus: effectiveOrderStatus,
        productionStage: effectiveProductionStage,
      };
    });

    // --------------------------------------------------
    // 6. Send response
    // --------------------------------------------------

    res.send(enrichedOrders);
  } catch (error) {
    console.error("My orders error:", error);

    res.status(500).send({
      message: error.message,
    });
  }
});

app.patch("/orders/:id", async (req, res) => {
  try {
    await connectToDatabase();
    const id = req.params.id;
    const query = { _id: new ObjectId(id) };

    const updateData = req.body;

    // If approving, you can also log when it was approved
    if (
      updateData.orderStatus === "approved" ||
      updateData.paymentStatus === "ready-for-payment"
    ) {
      updateData.approvedAt = new Date();
    }

    const result = await ordersCollection.updateOne(query, {
      $set: updateData,
    });

    if (result.matchedCount === 0) {
      return res.status(404).send({ message: "Order not found" });
    }

    // =====================================================
    // SYNC TRACKING STATUS IF ORDER IS APPROVED
    // =====================================================
    if (updateData.orderStatus === "approved") {
      await trackingCollection.updateOne(
        { orderId: new ObjectId(id) },
        {
          $set: {
            status: "approved",
            details:
              "Order has been approved by management and is ready for payment.",
            updatedAt: new Date(),
          },
        },
      );
    }

    res.send({
      success: true,
      message: "Order updated successfully",
      result,
    });
  } catch (error) {
    console.error("Order update error:", error);
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
app.post("/tracking", async (req, res) => {
  try {
    const trackingData = req.body;

    if (
      !trackingData.orderId ||
      !trackingData.trackingId ||
      !trackingData.status
    ) {
      return res
        .status(400)
        .send({ message: "Missing required tracking fields" });
    }

    // Convert orderId to ObjectId if it's being sent as a string from the client
    const queryOrderId =
      typeof trackingData.orderId === "string"
        ? new ObjectId(trackingData.orderId)
        : trackingData.orderId;

    // Optional: make sure orderId in the tracking document is also properly an ObjectId if needed
    trackingData.orderId = queryOrderId;

    // Insert into tracking/logs collection
    const result = await trackingCollection.insertOne(trackingData);

    // Keep the main order document synced with the latest status
    await ordersCollection.updateOne(
      { _id: queryOrderId },
      {
        $set: {
          orderStatus: trackingData.status,
          updatedAt: new Date(),
        },
      },
    );

    res.send({
      success: true,
      message: "Tracking update added successfully",
      result,
    });
  } catch (error) {
    console.error("Add tracking error:", error);
    res.status(500).send({ message: error.message });
  }
});

app.get("/trackings/:trackingId", async (req, res) => {
  try {
    await connectToDatabase();

    const trackingId = req.params.trackingId;

    // Fetch all logs matching this tracking ID, sorted by creation date (oldest to newest for timelines)
    const trackingLogs = await trackingCollection
      .find({ trackingId })
      .sort({ createdAt: 1 })
      .toArray();

    res.send(trackingLogs);
  } catch (error) {
    console.error("Fetch tracking error:", error);
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
