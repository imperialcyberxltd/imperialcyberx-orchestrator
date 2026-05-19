require('dotenv').config();
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');

const app = express();
app.use(cors());
app.use(express.json());

// Load service account (Ensure this file exists in production)
let serviceAccount;
try {
    serviceAccount = require('./firebase-service-account.json');
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
    console.log("Firebase Admin SDK Initialized.");
} catch (e) {
    console.warn("Warning: firebase-service-account.json missing. Drop your service account key into this directory to activate FCM.");
}

app.post('/api/enforce-lock', async (req, res) => {
    const { targetFcmToken, imei } = req.body;

    if (!targetFcmToken) {
        return res.status(400).json({ error: "FCM Token is required." });
    }

    const message = {
        token: targetFcmToken,
        data: {
            command: "IMPERIAL_LOCK",
            message: "EMI Default Detected. Device locked by Admin."
        }
    };

    try {
        if (!admin.apps.length) throw new Error("Firebase Admin not configured.");
        const response = await admin.messaging().send(message);
        res.status(200).json({ success: true, messageId: response });
    } catch (error) {
        console.error("FCM Delivery Error:", error);
        res.status(500).json({ error: error.message });
    }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`Orchestration Engine online on port ${PORT}`);
});

// API Endpoint to update hardware telemetry (Called by Android App)
app.post('/api/telemetry/sync', async (req, res) => {
    const { imei, lat, lng, operator, iccid, number } = req.body;

    try {
        const deviceRef = admin.firestore().collection('devices').doc(imei);
        
        await deviceRef.set({
            simProfile: { currentNumber: number, iccid: iccid, operator: operator },
            location: { lat: lat, lng: lng, updatedTimestamp: admin.firestore.FieldValue.serverTimestamp() }
        }, { merge: true });

        // Automated Trigger: If a new unapproved SIM is detected, flag it
        console.log(`Telemetry synchronized for IMEI: ${imei}`);
        res.status(200).json({ success: true, message: "Telemetry logged securely." });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// CRON/Worker API to automatically parse daily overdue records
app.post('/api/enforcement/cron-check', async (req, res) => {
    const todayStr = new Date().toISOString().split('T')[0]; // Format: YYYY-MM-DD
    
    try {
        const snapshot = await admin.firestore().collection('emi_schedules')
            .where('nextDueDate', '<', todayStr)
            .get();

        if (snapshot.empty) {
            return res.status(200).json({ message: "No overdue profiles detected today." });
        }

        let lockedCount = 0;
        for (const doc of snapshot.docs) {
            const data = doc.data();
            const imei = data.deviceImei;

            // Fetch current device FCM token
            const deviceDoc = await admin.firestore().collection('devices').doc(imei).get();
            if (deviceDoc.exists) {
                const token = deviceDoc.data().currentFcmToken;
                
                // Fire downstream high-priority lock payload
                const message = { token: token, data: { command: "IMPERIAL_LOCK" } };
                await admin.messaging().send(message);
                
                // Update statuses across both ledgers
                await doc.ref.update({ status: "SUSPENDED" });
                await deviceDoc.ref.update({ status: "LOCKED" });
                lockedCount++;
            }
        }
        res.status(200).json({ message: `Automated lock sequence fired for ${lockedCount} overdue records.` });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});
