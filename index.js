import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import dotenv from "dotenv";
import { MongoClient, ServerApiVersion, ObjectId } from "mongodb";
import Stripe from "stripe";
import crypto from "crypto";
import { initializeApp, cert } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import fs from "fs";

dotenv.config();

const stripe = new Stripe(process.env.STRIPE_SECRET);
const port = process.env.PORT || 3000;
const app = express();

const decoded = Buffer.from(process.env.FB_SERVICE_KEY, "base64").toString(
  "utf8",
);
const serviceAccount = JSON.parse(decoded);

let auth;

try {
  initializeApp({
    credential: cert(serviceAccount),
  });
  auth = getAuth();
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
const allowedOrigins = [
  "http://localhost:5173",
  "https://stitchflow-client.web.app",
].filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (like Postman or server-to-server)
      if (!origin) return callback(null, true);
      
      if (allowedOrigins.indexOf(origin) === -1) {
        return callback(new Error("The CORS policy for this site does not allow access from the specified Origin."), false);
      }
      return callback(null, true);
    },
    credentials: true,
  }),
);
app.use(express.json());
app.use(cookieParser());

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

// make login jwt token
app.post("/auth/login", async (req, res) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader?.startsWith("Bearer ")) {
      return res.status(401).send({
        message: "Unauthorized",
      });
    }

    const token = authHeader.split(" ")[1];

    const decodedToken = await auth.verifyIdToken(token);

    res.cookie("accessToken", token, {
      httpOnly: true,
      secure: true,
      sameSite: "none",
      maxAge: 60 * 60 * 1000,
    });

    res.send({
      success: true,
      email: decodedToken.email,
    });
  } catch (error) {
    console.error("Login error:", error);

    res.status(401).send({
      message: "Invalid authentication",
    });
  }
});

// jwt logout token
app.post("/auth/logout", (req, res) => {
  res.clearCookie("accessToken", {
    httpOnly: true,
    secure: true,
    sameSite: "none",
  });

  res.send({
    success: true,
  });
});

//Jwt middleware
const verifyFirebaseToken = async (req, res, next) => {
  try {
    const token = req.cookies.accessToken;

    if (!token) {
      return res.status(401).send({
        message: "Unauthorized access",
      });
    }

    const decodedToken = await auth.verifyIdToken(token);

    req.token_email = decodedToken.email;
    req.token_uid = decodedToken.uid;

    next();
  } catch (error) {
    console.error("Token verification error:", error);

    return res.status(401).send({
      message: "Unauthorized access",
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

// Admin middleware - must be use after verifyFirebaseToken
const verifyAdmin = async (req, res, next) => {
  await connectToDatabase();
  const email = req.token_email;
  const query = { email };
  const user = await usersCollection.findOne(query);

  if (!user || user.role !== "admin") {
    return res.status(403).send({ message: "Forbidden Access" });
  }

  next();
};

// Manager middleware - must be use after verifyFirebaseToken
const verifyManager = async (req, res, next) => {
  await connectToDatabase();
  const email = req.token_email;
  const query = { email };
  const user = await usersCollection.findOne(query);

  if (!user || user.role !== "manager") {
    return res.status(403).send({ message: "Forbidden Access" });
  }

  next();
};


// ** admin dashboard statistics
app.get(
  "/dashboard/admin-stats",
  verifyFirebaseToken,
  verifyAdmin,
  async (req, res) => {
    try {
      await connectToDatabase();
 
      const email = req.query.email;
      const range = req.query.range || "30days";
 
      if (!email || email !== req.token_email) {
        return res.status(403).send({
          message: "Forbidden access",
        });
      }
 
      const admin = await usersCollection.findOne({
        email,
      });
 
      if (!admin || admin.role !== "admin") {
        return res.status(403).send({
          message: "Forbidden. Admin access required.",
        });
      }
 
      const now = new Date();
 
      const startOfToday = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate(),
      );
 
      const startOfTomorrow = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate() + 1,
      );
 
      const startOf7Days = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate() - 6,
      );
 
      const startOf30Days = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate() - 29,
      );
 
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
 
      // Start of the 6-month window used for the monthly orders chart
      const startOf6Months = new Date(now.getFullYear(), now.getMonth() - 5, 1);
 
      let selectedStartDate = startOf30Days;
 
      if (range === "today") {
        selectedStartDate = startOfToday;
      }
 
      if (range === "7days") {
        selectedStartDate = startOf7Days;
      }
 
      if (range === "30days") {
        selectedStartDate = startOf30Days;
      }
 
      // Bulletproof local date helper with ObjectId timestamp fallback
      const getLocalDateKey = (doc) => {
        let dateObj = null;
 
        if (doc && doc.createdAt) {
          dateObj = new Date(doc.createdAt);
        }
 
        if ((!dateObj || isNaN(dateObj.getTime())) && doc && doc._id) {
          try {
            if (typeof doc._id.getTimestamp === "function") {
              dateObj = doc._id.getTimestamp();
            } else {
              const timestamp = parseInt(String(doc._id).substring(0, 8), 16) * 1000;
              dateObj = new Date(timestamp);
            }
          } catch (e) {
            // Ignore conversion error
          }
        }
 
        if (!dateObj || isNaN(dateObj.getTime())) return null;
 
        const year = dateObj.getFullYear();
        const month = String(dateObj.getMonth() + 1).padStart(2, "0");
        const day = String(dateObj.getDate()).padStart(2, "0");
        return `${year}-${month}-${day}`;
      };
 
      const approvedStatuses = ["approved", "payment-confirmed"];
 
      const productionStatuses = [
        "cutting-completed",
        "sewing-started",
        "finishing",
        "qc-checked",
      ];
 
      const completedStatuses = [
        "packed",
        "shipped",
        "out-for-delivery",
        "delivered",
      ];
 
      const [
        totalUsers,
        totalProducts,
        totalOrders,
        totalTrackings,
 
        productsToday,
        products7Days,
        products30Days,
 
        newUsersToday,
        newUsers7Days,
        newUsers30Days,
 
        activeManagers,
 
        ordersThisMonth,
 
        ordersInSelectedRange,
 
        allOrders,
 
        allTrackings,
 
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
 
        productsCollection.countDocuments({
          createdAt: {
            $gte: startOfToday,
            $lt: startOfTomorrow,
          },
        }),
 
        productsCollection.countDocuments({
          createdAt: {
            $gte: startOf7Days,
          },
        }),
 
        productsCollection.countDocuments({
          createdAt: {
            $gte: startOf30Days,
          },
        }),
 
        usersCollection.countDocuments({
          createdAt: {
            $gte: startOfToday,
            $lt: startOfTomorrow,
          },
        }),
 
        usersCollection.countDocuments({
          createdAt: {
            $gte: startOf7Days,
          },
        }),
 
        usersCollection.countDocuments({
          createdAt: {
            $gte: startOf30Days,
          },
        }),
 
        usersCollection.countDocuments({
          role: "manager",
          $or: [{ status: { $exists: false } }, { status: { $ne: "suspended" } }],
        }),
 
        ordersCollection.countDocuments({
          createdAt: {
            $gte: startOfMonth,
          },
        }),
 
        ordersCollection
          .find({
            createdAt: {
              $gte: selectedStartDate,
            },
          })
          .sort({
            createdAt: 1,
          })
          .toArray(),
 
        ordersCollection.find({}).toArray(),
 
        trackingCollection
          .find({})
          .sort({
            createdAt: -1,
          })
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
 
        // ============ MONTHLY ORDERS AGGREGATION (restored) ============
        ordersCollection
          .aggregate([
            {
              $match: {
                createdAt: {
                  $gte: startOf6Months,
                },
              },
            },
            {
              $group: {
                _id: {
                  year: { $year: "$createdAt" },
                  month: { $month: "$createdAt" },
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
 
      // ==================================================
      // GROUP TRACKINGS BY TRACKING ID
      // ==================================================
 
      const trackingMap = new Map();
 
      allTrackings.forEach((tracking) => {
        const trackingId = tracking.trackingId;
 
        if (!trackingId) {
          return;
        }
 
        if (!trackingMap.has(trackingId)) {
          trackingMap.set(trackingId, []);
        }
 
        trackingMap.get(trackingId).push(tracking);
      });
 
      // ==================================================
      // ENRICH ORDERS
      // ==================================================
 
      const enrichedOrders = allOrders.map((order) => {
        const orderTrackings = trackingMap.get(order.trackingId) || [];
 
        const statuses = orderTrackings
          .map((tracking) => tracking.status?.trim().toLowerCase())
          .filter(Boolean);
 
        const latestTracking =
          [...orderTrackings].sort(
            (a, b) => new Date(b.createdAt) - new Date(a.createdAt),
          )[0] || null;
 
        const isApproved =
          approvedStatuses.some((status) => statuses.includes(status)) ||
          Boolean(order.approvedAt) ||
          order.orderStatus === "approved";
 
        const isRejected =
          statuses.includes("rejected") || order.orderStatus === "rejected";
 
        const isPending =
          !isApproved &&
          !isRejected &&
          (statuses.includes("pending-review") ||
            order.orderStatus === "pending-review" ||
            order.orderStatus === "pending");
 
        const isInProduction =
          productionStatuses.some((status) => statuses.includes(status)) ||
          productionStatuses.includes(order.orderStatus);
 
        const isCompleted =
          completedStatuses.some((status) => statuses.includes(status)) ||
          completedStatuses.includes(order.orderStatus);
 
        let effectiveStatus = "unknown";
 
        if (isRejected) {
          effectiveStatus = "rejected";
        } else if (isCompleted) {
          effectiveStatus = "completed";
        } else if (isInProduction) {
          effectiveStatus = "in-production";
        } else if (isApproved) {
          effectiveStatus = "approved";
        } else if (isPending) {
          effectiveStatus = "pending";
        }
 
        let productionStage = order.productionStage || "not-started";
 
        if (isInProduction) {
          productionStage = "in-production";
        }
 
        if (isCompleted) {
          productionStage = "completed";
        }
 
        return {
          ...order,
 
          trackingStatus: latestTracking?.status || null,
 
          trackingStatusLabel: latestTracking?.statusLabel || null,
 
          trackingLocation: latestTracking?.location || null,
 
          trackingDetails: latestTracking?.details || null,
 
          trackingUpdatedAt:
            latestTracking?.dateTime || latestTracking?.createdAt || null,
 
          effectiveStatus,
 
          productionStage,
 
          isApproved: Boolean(isApproved),
          isInProduction: Boolean(isInProduction),
          isCompleted: Boolean(isCompleted),
          isRejected: Boolean(isRejected),
          isPending: Boolean(isPending),
        };
      });
 
      // ==================================================
      // ORDER STATISTICS
      // ==================================================
 
      const pendingOrders = enrichedOrders.filter((order) => order.isPending).length;
 
      const approvedOrders = enrichedOrders.filter((order) => order.isApproved).length;
 
      const rejectedOrders = enrichedOrders.filter((order) => order.isRejected).length;
 
      const inProductionOrders = enrichedOrders.filter(
        (order) => order.isInProduction,
      ).length;
 
      const completedOrders = enrichedOrders.filter((order) => order.isCompleted).length;
 
      // ==================================================
      // PAYMENT STATISTICS
      // ==================================================
 
      const paidOrders = enrichedOrders.filter(
        (order) => order.paymentStatus?.toLowerCase() === "paid",
      ).length;
 
      const unpaidOrders = totalOrders - paidOrders;
 
      const totalRevenue = enrichedOrders
        .filter((order) => order.paymentStatus?.toLowerCase() === "paid")
        .reduce((sum, order) => sum + Number(order.totalPrice || 0), 0);
 
      // ==================================================
      // USERS BY ROLE
      // ==================================================
 
      const usersByRole = {
        buyer: 0,
        manager: 0,
        admin: 0,
      };
 
      userRoleResult.forEach((item) => {
        if (item._id) {
          usersByRole[item._id] = item.count;
        }
      });
 
      // ==================================================
      // ORDER STATUS CHART
      // ==================================================
 
      const orderStatus = [
        {
          status: "pending",
          count: pendingOrders,
        },
        {
          status: "approved",
          count: approvedOrders,
        },
        {
          status: "rejected",
          count: rejectedOrders,
        },
        {
          status: "in-production",
          count: inProductionOrders,
        },
        {
          status: "completed",
          count: completedOrders,
        },
      ].filter((item) => item.count > 0);
 
      // ==================================================
      // MONTHLY ORDERS (restored — used by the "Monthly orders" area chart)
      // ==================================================
 
      const monthlyOrders = monthlyOrdersResult.map((item) => ({
        month: `${item._id.year}-${String(item._id.month).padStart(2, "0")}`,
        orders: item.orders,
      }));
 
      // ==================================================
      // ORDERS BY DATE
      // ==================================================
 
      const ordersByDateMap = new Map();
 
      ordersInSelectedRange.forEach((order) => {
        const key = getLocalDateKey(order);
        if (!key) return;
 
        if (!ordersByDateMap.has(key)) {
          ordersByDateMap.set(key, 0);
        }
 
        ordersByDateMap.set(key, ordersByDateMap.get(key) + 1);
      });
 
      const ordersByDate = [];
      const cursorDate = new Date(selectedStartDate);
 
      while (cursorDate < startOfTomorrow) {
        const key = getLocalDateKey({ createdAt: cursorDate });
        if (key) {
          ordersByDate.push({
            date: key,
            orders: ordersByDateMap.get(key) || 0,
          });
        }
        cursorDate.setDate(cursorDate.getDate() + 1);
      }
 
      // ==================================================
      // PRODUCTS BY DATE
      // ==================================================
 
      const productsForChart = await productsCollection
        .find({
          createdAt: {
            $gte: selectedStartDate,
          },
        })
        .sort({
          createdAt: 1,
        })
        .toArray();
 
      const productsByDateMap = new Map();
 
      productsForChart.forEach((product) => {
        const key = getLocalDateKey(product);
        if (!key) return;
 
        if (!productsByDateMap.has(key)) {
          productsByDateMap.set(key, 0);
        }
 
        productsByDateMap.set(key, productsByDateMap.get(key) + 1);
      });
 
      const productsByDate = [];
      const productCursor = new Date(selectedStartDate);
 
      while (productCursor < startOfTomorrow) {
        const key = getLocalDateKey({ createdAt: productCursor });
        if (key) {
          productsByDate.push({
            date: key,
            products: productsByDateMap.get(key) || 0,
          });
        }
        productCursor.setDate(productCursor.getDate() + 1);
      }
 
      // ==================================================
      // USERS BY DATE
      // ==================================================
 
      const usersForChart = await usersCollection
        .find({
          createdAt: {
            $gte: selectedStartDate,
          },
        })
        .sort({
          createdAt: 1,
        })
        .toArray();
 
      const usersByDateMap = new Map();
 
      usersForChart.forEach((user) => {
        const key = getLocalDateKey(user);
        if (!key) return;
 
        if (!usersByDateMap.has(key)) {
          usersByDateMap.set(key, 0);
        }
 
        usersByDateMap.set(key, usersByDateMap.get(key) + 1);
      });
 
      const usersByDate = [];
      const userCursor = new Date(selectedStartDate);
 
      while (userCursor < startOfTomorrow) {
        const key = getLocalDateKey({ createdAt: userCursor });
        if (key) {
          usersByDate.push({
            date: key,
            users: usersByDateMap.get(key) || 0,
          });
        }
        userCursor.setDate(userCursor.getDate() + 1);
      }
 
      // ==================================================
      // RESPONSE
      // ==================================================
 
      res.send({
        range,
 
        stats: {
          totalUsers,
          totalProducts,
          totalOrders,
          totalTrackings,
 
          productsToday,
          products7Days,
          products30Days,
 
          ordersThisMonth,
 
          newUsersToday,
          newUsers7Days,
          newUsers30Days,
 
          activeManagers,
 
          pendingOrders,
          approvedOrders,
          rejectedOrders,
          inProductionOrders,
          completedOrders,
 
          paidOrders,
          unpaidOrders,
 
          totalRevenue,
        },
 
        usersByRole,
 
        orderStatus,
 
        // Kept at top level so existing frontend code (`data?.monthlyOrders`) keeps working
        monthlyOrders,
 
        charts: {
          ordersByDate,
          productsByDate,
          usersByDate,
        },
 
        recentOrders: [...recentOrders].map((order) => {
          const enriched = enrichedOrders.find(
            (item) => String(item._id) === String(order._id),
          );
 
          return enriched || order;
        }),
 
        recentProducts,
 
        recentTrackings,
      });
    } catch (error) {
      console.error("Admin dashboard error:", error);
 
      res.status(500).send({
        message: "Failed to load admin dashboard",
      });
    }
  },
);

// ** manager dashboard statistics
app.get(
  "/manager/dashboard",
  verifyFirebaseToken,
  verifyManager,
  async (req, res) => {
    try {
      await connectToDatabase();

      // -----------------------------------------
      // 1. Fetch products, orders and trackings
      // -----------------------------------------
      const [totalProducts, orders, trackings] = await Promise.all([
        productsCollection.countDocuments(),

        ordersCollection.find({}).toArray(),

        trackingCollection.find({}).sort({ createdAt: -1 }).toArray(),
      ]);

      // -----------------------------------------
      // 2. Group trackings by trackingId
      // -----------------------------------------
      const trackingMap = new Map();

      trackings.forEach((tracking) => {
        const trackingId = tracking.trackingId;

        if (!trackingId) return;

        if (!trackingMap.has(trackingId)) {
          trackingMap.set(trackingId, []);
        }

        trackingMap.get(trackingId).push(tracking);
      });

      // -----------------------------------------
      // 3. Status definitions
      // -----------------------------------------
      const approvedStatuses = ["approved", "payment-confirmed"];

      const productionStatuses = [
        "cutting-completed",
        "sewing-started",
        "finishing",
        "qc-checked",
      ];

      const completedStatuses = [
        "packed",
        "shipped",
        "out-for-delivery",
        "delivered",
      ];

      // -----------------------------------------
      // 4. Enrich orders
      // -----------------------------------------
      const enrichedOrders = orders.map((order) => {
        const orderTrackings = trackingMap.get(order.trackingId) || [];

        const statuses = orderTrackings
          .map((tracking) => tracking.status?.trim().toLowerCase())
          .filter(Boolean);

        const latestTracking =
          [...orderTrackings].sort(
            (a, b) => new Date(b.createdAt) - new Date(a.createdAt),
          )[0] || null;

        // -----------------------------------------
        // Approved
        // -----------------------------------------
        const isApproved =
          approvedStatuses.some((status) => statuses.includes(status)) ||
          order.approvedAt ||
          order.orderStatus === "approved";

        // -----------------------------------------
        // Rejected
        // -----------------------------------------
        const isRejected =
          statuses.includes("rejected") || order.orderStatus === "rejected";

        // -----------------------------------------
        // Pending
        // -----------------------------------------
        const isPending =
          !isApproved &&
          !isRejected &&
          (statuses.includes("pending-review") ||
            order.orderStatus === "pending-review" ||
            order.orderStatus === "pending");

        // -----------------------------------------
        // In production
        // -----------------------------------------
        const isInProduction = productionStatuses.some((status) =>
          statuses.includes(status),
        );

        // -----------------------------------------
        // Completed
        // -----------------------------------------
        const isCompleted = completedStatuses.some((status) =>
          statuses.includes(status),
        );

        // -----------------------------------------
        // Effective order status
        // -----------------------------------------
        let effectiveStatus = "unknown";

        if (isRejected) {
          effectiveStatus = "rejected";
        } else if (isApproved) {
          effectiveStatus = "approved";
        } else if (isPending) {
          effectiveStatus = "pending-review";
        }

        // -----------------------------------------
        // Production stage
        // -----------------------------------------
        let productionStage = order.productionStage || "not-started";

        if (isInProduction) {
          productionStage = "in-production";
        }

        if (isCompleted) {
          productionStage = "completed";
        }

        return {
          ...order,

          trackingStatus: latestTracking?.status || null,

          trackingStatusLabel: latestTracking?.statusLabel || null,

          trackingLocation: latestTracking?.location || null,

          trackingDetails: latestTracking?.details || null,

          trackingUpdatedAt:
            latestTracking?.dateTime || latestTracking?.createdAt || null,

          effectiveStatus,

          productionStage,

          isApproved: Boolean(isApproved),
          isInProduction,
          isCompleted,
          isRejected,
          isPending,
        };
      });

      // -----------------------------------------
      // 5. Statistics
      // -----------------------------------------
      const totalOrders = enrichedOrders.length;

      const pendingOrders = enrichedOrders.filter(
        (order) => order.isPending,
      ).length;

      const approvedOrders = enrichedOrders.filter(
        (order) => order.isApproved,
      ).length;

      const rejectedOrders = enrichedOrders.filter(
        (order) => order.isRejected,
      ).length;

      const inProductionOrders = enrichedOrders.filter(
        (order) => order.isInProduction,
      ).length;

      const completedOrders = enrichedOrders.filter(
        (order) => order.isCompleted,
      ).length;

      // -----------------------------------------
      // 6. Recent orders
      // -----------------------------------------
      const recentOrders = [...enrichedOrders]
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        .slice(0, 5);

      // -----------------------------------------
      // 7. Response
      // -----------------------------------------
      res.send({
        stats: {
          totalProducts,
          totalOrders,

          pendingOrders,
          approvedOrders,
          rejectedOrders,

          inProductionOrders,
          completedOrders,
        },

        recentOrders,
      });
    } catch (error) {
      console.error("Manager dashboard error:", error);

      res.status(500).send({
        message: "Failed to load manager dashboard",
      });
    }
  },
);

// Get buyer dashboard statistics
app.get("/dashboard/buyer-stats", verifyFirebaseToken, async (req, res) => {
  try {
    await connectToDatabase();

    const email = req.query.email;

    if (!email || email !== req.token_email) {
      return res.status(403).send({
        message: "Forbidden access",
      });
    }

    const orders = await ordersCollection
      .find({
        customerEmail: email,
      })
      .toArray();

    if (orders.length === 0) {
      return res.send({
        stats: {
          totalOrders: 0,
          pendingOrders: 0,
          approvedOrders: 0,
          rejectedOrders: 0,
          completedOrders: 0,
          paidOrders: 0,
          unpaidOrders: 0,
          totalSpent: 0,
        },
        orderStatus: [],
        recentOrders: [],
        activeOrder: null,
      });
    }

    const trackingIds = orders.map((order) => order.trackingId).filter(Boolean);

    const trackings = await trackingCollection
      .find({
        trackingId: {
          $in: trackingIds,
        },
      })
      .toArray();

    const trackingMap = new Map();

    trackings.forEach((tracking) => {
      const trackingId = tracking.trackingId;

      if (!trackingId) return;

      if (!trackingMap.has(trackingId)) {
        trackingMap.set(trackingId, []);
      }

      trackingMap.get(trackingId).push(tracking);
    });

    const enrichedOrders = orders.map((order) => {
      const orderTrackings = trackingMap.get(order.trackingId) || [];

      const statuses = orderTrackings
        .map((tracking) => tracking.status?.trim().toLowerCase())
        .filter(Boolean);

      const latestTracking =
        [...orderTrackings].sort(
          (a, b) => new Date(b.createdAt) - new Date(a.createdAt),
        )[0] || null;

      let effectiveStatus = "pending";

      if (statuses.includes("rejected") || order.orderStatus === "rejected") {
        effectiveStatus = "rejected";
      } else if (
        statuses.includes("approved") ||
        statuses.includes("payment-confirmed") ||
        order.approvedAt ||
        order.orderStatus === "approved"
      ) {
        effectiveStatus = "approved";
      } else if (
        statuses.includes("pending-review") ||
        order.orderStatus === "pending-review"
      ) {
        effectiveStatus = "pending";
      }

      let productionStage = order.productionStage || "not-started";

      const productionStatuses = [
        "cutting-completed",
        "sewing-started",
        "finishing",
        "qc-checked",
      ];

      const completedStatuses = [
        "packed",
        "shipped",
        "out-for-delivery",
        "delivered",
      ];

      if (statuses.some((status) => productionStatuses.includes(status))) {
        productionStage = "in-production";
      }

      if (statuses.some((status) => completedStatuses.includes(status))) {
        productionStage = "completed";
      }

      return {
        ...order,
        trackingStatus: latestTracking?.status || null,
        trackingStatusLabel: latestTracking?.statusLabel || null,
        trackingLocation: latestTracking?.location || null,
        trackingDetails: latestTracking?.details || null,
        trackingUpdatedAt:
          latestTracking?.dateTime || latestTracking?.createdAt || null,
        effectiveStatus,
        productionStage,
      };
    });

    const totalOrders = enrichedOrders.length;

    const pendingOrders = enrichedOrders.filter(
      (order) => order.effectiveStatus === "pending",
    ).length;

    const approvedOrders = enrichedOrders.filter(
      (order) => order.effectiveStatus === "approved",
    ).length;

    const rejectedOrders = enrichedOrders.filter(
      (order) => order.effectiveStatus === "rejected",
    ).length;

    const completedOrders = enrichedOrders.filter(
      (order) => order.productionStage === "completed",
    ).length;

    const paidOrders = enrichedOrders.filter(
      (order) => order.paymentStatus === "paid",
    ).length;

    const unpaidOrders = totalOrders - paidOrders;

    const totalSpent = enrichedOrders
      .filter((order) => order.paymentStatus === "paid")
      .reduce((sum, order) => sum + Number(order.totalPrice || 0), 0);

    const orderStatus = [
      {
        status: "pending",
        count: pendingOrders,
      },
      {
        status: "approved",
        count: approvedOrders,
      },
      {
        status: "rejected",
        count: rejectedOrders,
      },
      {
        status: "completed",
        count: completedOrders,
      },
    ].filter((item) => item.count > 0);

    const recentOrders = [...enrichedOrders]
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, 5);

    const activeOrder =
      enrichedOrders.find(
        (order) =>
          order.effectiveStatus === "approved" &&
          order.productionStage !== "completed",
      ) || null;

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
      activeOrder,
    });
  } catch (error) {
    console.error("Buyer stats error:", error);

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

app.get("/users", verifyFirebaseToken, verifyAdmin, async (req, res) => {
  try {
    await connectToDatabase();

    const search = req.query.search || "";
    const role = req.query.role || "";
    const status = req.query.status || "";
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 5;
    const skip = (page - 1) * limit;

    const query = {};

    if (search) {
      query.$or = [
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
      ];
    }

    if (role) {
      query.role = role;
    }

    if (status) {
      query.status = status;
    }

    const users = await usersCollection
      .find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .toArray();

    const totalUsers = await usersCollection.countDocuments(query);

    res.send({ users, totalUsers });
  } catch (error) {
    console.log(error);
    res.status(500).send({
      message: "Failed to get users",
    });
  }
});

app.patch("/users/:id", verifyFirebaseToken, verifyAdmin, async (req, res) => {
  try {
    await connectToDatabase();

    const id = req.params.id;
    const { role, status, suspendReason, suspendFeedback } = req.body;

    const updateData = {};

    if (role !== undefined) {
      updateData.role = role;
    }

    if (status !== undefined) {
      updateData.status = status;
    }

    if (suspendReason !== undefined) {
      updateData.suspendReason = suspendReason;
    }

    if (suspendFeedback !== undefined) {
      updateData.suspendFeedback = suspendFeedback;
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
app.post("/products", verifyFirebaseToken, verifyManager, async (req, res) => {
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
app.get(
  "/products/manager",
  verifyFirebaseToken,
  verifyManager,
  async (req, res) => {
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
  },
);

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

app.patch(
  "/products/home/:id",
  verifyFirebaseToken,
  verifyAdmin,
  async (req, res) => {
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
  },
);

app.patch(
  "/products/:id",
  verifyFirebaseToken,
  verifyAdmin,
  async (req, res) => {
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
  },
);

app.delete(
  "/products/:id",
  verifyFirebaseToken,
  verifyAdmin,
  async (req, res) => {
    try {
      await connectToDatabase();

      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await productsCollection.deleteOne(query);
      res.send(result);
    } catch (error) {
      res.status(500).send({ message: error.message });
    }
  },
);

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

app.post("/orders", verifyFirebaseToken, async (req, res) => {
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
      !customerEmail ||
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

app.get("/orders", verifyFirebaseToken, verifyAdmin, async (req, res) => {
  try {
    await connectToDatabase();

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 5;
    const search = (req.query.search || "").toLowerCase();
    const statusFilter = req.query.status || "all";

    const orders = await ordersCollection
      .find()
      .sort({ createdAt: -1 })
      .toArray();

    // 1. Gather all tracking IDs and order IDs to link records
    const trackingIds = orders.map((o) => o.trackingId).filter(Boolean);
    const orderIds = orders.map((o) => o._id);

    // Fetch tracking logs sorted by newest first
    const trackings = await trackingCollection
      .find({
        $or: [
          { trackingId: { $in: trackingIds } },
          { id: { $in: trackingIds } },
          { tracking_id: { $in: trackingIds } },
          { orderId: { $in: orderIds } },
        ],
      })
      .sort({ createdAt: -1 })
      .toArray();

    // 2. Build map prioritizing the latest status
    const trackingMap = new Map();
    trackings.forEach((t) => {
      const tId = t.trackingId || t.id || t.tracking_id;
      const tStatus = t.status ? t.status.toLowerCase() : "";

      if (tId && !trackingMap.has(tId)) {
        trackingMap.set(tId, tStatus);
      }
      if (t.orderId && !trackingMap.has(t.orderId.toString())) {
        trackingMap.set(t.orderId.toString(), tStatus);
      }
    });

    // 3. Enrich orders with trackingStatus, effective orderStatus, and dynamic productionStage
    const enrichedOrders = orders.map((o) => {
      const trackingStatus =
        trackingMap.get(o.trackingId) ||
        trackingMap.get(o._id.toString()) ||
        null;

      const approvedStatuses = [
        "approved",
        "payment-confirmed",
        "cutting-completed",
        "in-production",
      ];
      const isApprovedByTracking = approvedStatuses.includes(trackingStatus);

      const effectiveStatus = isApprovedByTracking ? "approved" : o.orderStatus;

      let effectiveProductionStage = o.productionStage;
      const currentActiveStatus = trackingStatus || o.orderStatus;

      if (
        ["cutting-completed", "in-production", "cutting"].includes(
          currentActiveStatus,
        )
      ) {
        effectiveProductionStage = "in-progress";
      }

      return {
        ...o,
        trackingStatus,
        orderStatus: effectiveStatus,
        productionStage: effectiveProductionStage,
      };
    });

    // 4. Calculate Stats across all enriched orders
    const stats = {
      total: enrichedOrders.length,
      pending: enrichedOrders.filter((o) => o.orderStatus === "pending-review")
        .length,
      approved: enrichedOrders.filter((o) => o.orderStatus === "approved")
        .length,
      rejected: enrichedOrders.filter((o) => o.orderStatus === "rejected")
        .length,
      paid: enrichedOrders.filter((o) => o.paymentStatus === "paid").length,
    };

    // 5. Apply Search & Status Filters on Enriched Orders
    const filteredOrders = enrichedOrders.filter((o) => {
      const matchesSearch =
        !search ||
        o.trackingId?.toLowerCase().includes(search) ||
        o.customerEmail?.toLowerCase().includes(search) ||
        o.productTitle?.toLowerCase().includes(search) ||
        o.firstName?.toLowerCase().includes(search) ||
        o.lastName?.toLowerCase().includes(search);

      const matchesStatus =
        statusFilter === "all" || o.orderStatus === statusFilter;

      return matchesSearch && matchesStatus;
    });

    // 6. Paginate Results
    const totalOrdersCount = filteredOrders.length;
    const totalPages = Math.ceil(totalOrdersCount / limit) || 1;
    const skip = (page - 1) * limit;
    const paginatedOrders = filteredOrders.slice(skip, skip + limit);

    res.send({
      orders: paginatedOrders,
      totalPages,
      stats,
    });
  } catch (error) {
    res.status(500).send({ message: error.message });
  }
});

app.get(
  "/orders/manager",
  verifyFirebaseToken,
  verifyManager,
  async (req, res) => {
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
  },
);

// Get all orders of logged-in buyer
app.get("/orders/my-orders", verifyFirebaseToken, async (req, res) => {
  try {
    await connectToDatabase();

    const email = req.query.email;

    if (!email) {
      return res.status(400).send({
        message: "Email is required",
      });
    }

    if (email !== req.token_email) {
      return res.status(403).send({
        message: "Forbidden access",
      });
    }

    const orders = await ordersCollection
      .find({
        customerEmail: email,
      })
      .sort({
        createdAt: -1,
      })
      .toArray();

    if (orders.length === 0) {
      return res.send([]);
    }

    const trackingIds = orders.map((order) => order.trackingId).filter(Boolean);

    const trackings = await trackingCollection
      .find({
        trackingId: {
          $in: trackingIds,
        },
      })
      .sort({
        createdAt: -1,
      })
      .toArray();

    const trackingMap = new Map();

    trackings.forEach((tracking) => {
      const trackingId = tracking.trackingId;

      if (!trackingId) return;

      if (!trackingMap.has(trackingId)) {
        trackingMap.set(trackingId, []);
      }

      trackingMap.get(trackingId).push({
        status: tracking.status?.trim().toLowerCase() || null,
        statusLabel: tracking.statusLabel || null,
        location: tracking.location || null,
        details: tracking.details || null,
        dateTime: tracking.dateTime || null,
        createdAt: tracking.createdAt || null,
        updatedAt: tracking.updatedAt || null,
      });
    });

    const enrichedOrders = orders.map((order) => {
      const orderTrackings = trackingMap.get(order.trackingId) || [];

      const statuses = orderTrackings
        .map((tracking) => tracking.status)
        .filter(Boolean);

      const latestTracking = orderTrackings[0] || null;

      let effectiveOrderStatus = "pending";

      if (
        statuses.includes("approved") ||
        statuses.includes("payment-confirmed") ||
        statuses.includes("cutting-completed") ||
        statuses.includes("sewing-started") ||
        statuses.includes("finishing") ||
        statuses.includes("qc-checked") ||
        statuses.includes("packed") ||
        statuses.includes("shipped") ||
        statuses.includes("out-for-delivery") ||
        statuses.includes("delivered")
      ) {
        effectiveOrderStatus = "approved";
      }

      if (statuses.includes("rejected")) {
        effectiveOrderStatus = "rejected";
      }

      let productionStage = "not-started";

      const productionStatuses = [
        "cutting-completed",
        "sewing-started",
        "finishing",
        "qc-checked",
      ];

      const completedStatuses = [
        "packed",
        "shipped",
        "out-for-delivery",
        "delivered",
      ];

      if (statuses.some((status) => productionStatuses.includes(status))) {
        productionStage = "in-production";
      }

      if (statuses.some((status) => completedStatuses.includes(status))) {
        productionStage = "completed";
      }

      return {
        ...order,
        orderStatus: effectiveOrderStatus,
        productionStage,
        trackingStatus: latestTracking?.status || null,
        trackingStatusLabel: latestTracking?.statusLabel || null,
        trackingLocation: latestTracking?.location || null,
        trackingDetails: latestTracking?.details || null,
        trackingUpdatedAt:
          latestTracking?.dateTime || latestTracking?.createdAt || null,
      };
    });

    res.send(enrichedOrders);
  } catch (error) {
    console.error("My orders error:", error);

    res.status(500).send({
      message: error.message,
    });
  }
});

app.patch(
  "/orders/:id",
  verifyFirebaseToken,
  verifyManager,
  async (req, res) => {
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
  },
);

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

app.get("/orders/:orderId/tracking", verifyFirebaseToken, async (req, res) => {
  try {
    await connectToDatabase();

    const { orderId } = req.params;

    // =========================
    // VALIDATE ORDER ID
    // =========================

    if (!ObjectId.isValid(orderId)) {
      return res.status(400).send({
        message: "Invalid order ID",
      });
    }

    // =========================
    // FIND ORDER
    // =========================

    const order = await ordersCollection.findOne({
      _id: new ObjectId(orderId),
    });

    if (!order) {
      return res.status(404).send({
        message: "Order not found",
      });
    }

    // =========================
    // CHECK ORDER OWNERSHIP
    // =========================

    if (order.customerEmail !== req.token_email) {
      return res.status(403).send({
        message: "Forbidden access",
      });
    }

    // =========================
    // FIND TRACKING HISTORY
    // =========================

    const trackingLogs = await trackingCollection
      .find({
        trackingId: order.trackingId,
      })
      .sort({
        createdAt: 1,
      })
      .toArray();

    // =========================
    // RESPONSE
    // =========================

    res.send({
      order: {
        _id: order._id,
        trackingId: order.trackingId,
        productTitle: order.productTitle,
        productImage: order.productImage,
        quantity: order.quantity,
        paymentStatus: order.paymentStatus,
        orderStatus: order.orderStatus,
        createdAt: order.createdAt,
      },

      trackingLogs,
    });
  } catch (error) {
    console.error("Order tracking error:", error);

    res.status(500).send({
      message: error.message,
    });
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

    const queryOrderId =
      typeof trackingData.orderId === "string"
        ? new ObjectId(trackingData.orderId)
        : trackingData.orderId;

    trackingData.orderId = queryOrderId;

    // CRITICAL FIX: Ensure every tracking entry gets a precise timestamp
    trackingData.createdAt = trackingData.createdAt || new Date();

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

export default app;
