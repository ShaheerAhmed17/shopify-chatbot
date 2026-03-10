const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');

const app = express();
app.use(bodyParser.json());

const SHOPIFY_STORE = 'dem0stor3.myshopify.com';
const ADMIN_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;

// --- /order_status endpoint ---
app.post('/order_status', async (req, res) => {
    const { order_number, customer_email } = req.body;

    try {
        const orderName = order_number.startsWith('#') ? order_number : `#${order_number}`;

        // Fetch order from Shopify
        const response = await axios.get(
            `https://${SHOPIFY_STORE}/admin/api/2026-01/orders.json`,
            {
                headers: { 'X-Shopify-Access-Token': ADMIN_TOKEN },
                params: {
                    name: orderName,
                    status: 'any',
                }
            }
        );

        const orders = response.data.orders;
        if (!orders.length) return res.json({ found: false });

        const order = orders[0];
        const fulfillment = order.fulfillments?.[0];

        // Build item list
        const items = order.line_items.map(i => ({
            title: i.title,
            quantity: i.quantity
        }));

        // Fulfilled items (for partial fulfillment)
        const fulfilled_items = fulfillment?.line_items?.map(i => ({
            title: i.title,
            quantity: i.quantity
        })) || [];

        // Customer name
        const customer_name = order.customer?.first_name || "Customer";

        // Shipping info safe-check
        const shipping_country = order.shipping_address?.country || 'Unknown';

        // Estimated fulfillment: add 7 days if unfulfilled
        let estimated_fulfillment = null;
        if (order.fulfillment_status !== 'fulfilled') {
            const created = new Date(order.created_at);
            const estimate = new Date(created);
            estimate.setDate(created.getDate() + 7);
            estimated_fulfillment = estimate.toDateString();
        }

        res.json({
            found: true,
            order_number: order.name,
            status: order.fulfillment_status || 'unfulfilled',
            tracking_url: fulfillment?.tracking_url || null,
            created_at: order.created_at,
            shipping_country,
            customer_name,
            items,
            fulfilled_items,
            estimated_fulfillment
        });

    } catch (err) {
        console.error("Shopify /order_status error:", err.response?.data || err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// --- /return_policy endpoint ---
app.post('/return_policy', (req, res) => {
    const { order_status, used } = req.body;
    const allowed = order_status === 'fulfilled' && !used;
    res.json({ return_allowed: allowed });
});

// --- /delivery_estimate endpoint ---
app.post('/delivery_estimate', (req, res) => {
    const { created_at, shipping_country, status } = req.body;

    let estimate = 'Unknown';
    if (status === 'fulfilled') {
        estimate = 'Already fulfilled';
    } else if (created_at) {
        const created = new Date(created_at);
        const estimatedFulfill = new Date(created);
        estimatedFulfill.setDate(created.getDate() + 7); // 7-day simple estimate
        estimate = estimatedFulfill.toDateString();
    }

    res.json({ estimate });
});

// --- Health check endpoint ---
app.get('/health', (req, res) => {
    res.json({ status: 'Shopify demo backend running', time: new Date() });
});

// --- Start Shopify demo backend ---
app.listen(3000, () => {
    console.log('Shopify demo backend running on http://localhost:3000');
});