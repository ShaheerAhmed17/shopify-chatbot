const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const path = require('path');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(bodyParser.json());

app.use(express.static(path.join(__dirname, 'public')));

const SHOPIFY_BACKEND = process.env.SHOPIFY_BACKEND_URL || 'http://localhost:3000';
const PHI3_BACKEND = process.env.PHI3_BACKEND_URL || 'http://localhost:8000';

// --- Products cache (refreshes every 10 minutes) ---
let productsCache = null;
let productsCacheTime = 0;

async function getProducts() {
    const now = Date.now();
    if (productsCache && (now - productsCacheTime) < 10 * 60 * 1000) {
        return productsCache;
    }
    try {
        const r = await axios.get(`${SHOPIFY_BACKEND}/products`);
        productsCache = r.data.products;
        productsCacheTime = now;
        return productsCache;
    } catch (err) {
        console.error("Failed to fetch products:", err.message);
        return [];
    }
}

function extractJSON(text) {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('Failed to extract JSON from response');
    return JSON.parse(match[0]);
}

function extractOrderNumber(message) {
    const match = message.match(/#?(\d{3,})/);
    return match ? match[1] : null;
}

function autoSelectTool(message) {
    const lower = message.toLowerCase();

    if (lower.includes("order") || lower.includes("where is my order") || lower.includes("status")) {
        const orderNumber = extractOrderNumber(message);
        if (orderNumber) return { tool: "get_order_status", args: { order_number: orderNumber } };
    }

    if (lower.includes("return") || lower.includes("refund")) {
        return { tool: "get_return_policy", args: {} };
    }

    if (lower.includes("delivery") || lower.includes("shipping")) {
        return { tool: "get_delivery_estimate", args: {} };
    }

    return null;
}

// --- Conversational reply with real product context ---
async function getConversationalReply(message) {
    const products = await getProducts();
    const productList = products.length
        ? products.map(p => `- ${p.title} (${p.type}) — $${p.price}`).join('\n')
        : 'Product list currently unavailable.';

    const prompt = `You are a helpful customer support assistant for a luxury car store.

Current products listed on the store:
${productList}

Store policies:
- Orders are fulfilled within 7 days
- Returns are accepted on fulfilled, unused orders
- For order tracking, customers must provide their order number (e.g. #1001)

Answer the customer's question naturally and helpfully using the above information.
Do NOT make up products or prices that are not listed above.
Customer message: "${message}"`;

    const response = await axios.post(`${PHI3_BACKEND}/chat`, { message: prompt });
    return response.data.response?.trim() || "I'm not sure how to help with that. Could you rephrase?";
}

app.post('/ask', async (req, res) => {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: "Message is required" });

    try {
        let toolJSON = autoSelectTool(message);

        // --- Order status shortcut ---
        if (toolJSON && toolJSON.tool === 'get_order_status') {
            const r = await axios.post(`${SHOPIFY_BACKEND}/order_status`, toolJSON.args || {});
            const data = r.data;

            if (!data.found) {
                return res.json({ answer: "I'm sorry, I couldn't find updates for your order right now. Please try again later or contact support." });
            }

            const itemsList = data.items
                ? data.items.map(i => `${i.quantity} x ${i.title}`).join(", ")
                : "Items info unavailable";

            let fulfillmentMsg;
            if (data.status === 'fulfilled') {
                fulfillmentMsg = data.tracking_url
                    ? `Tracking URL: ${data.tracking_url}.`
                    : "All items have been fulfilled. Tracking info not available.";
            } else if (data.status === 'partial') {
                const shippedItems = data.fulfilled_items
                    ? data.fulfilled_items.map(i => `${i.quantity} x ${i.title}`).join(", ")
                    : "Some items";
                fulfillmentMsg = `Partially fulfilled. Shipped items: ${shippedItems}. Remaining items will be fulfilled soon.`;
            } else {
                const estimateResp = await axios.post(`${SHOPIFY_BACKEND}/delivery_estimate`, {
                    shipping_country: data.shipping_country,
                    created_at: data.created_at,
                    order_status: data.status
                });
                fulfillmentMsg = `Estimated fulfillment: ${estimateResp.data.estimate}.`;
            }

            return res.json({
                answer: `Hello ${data.customer_name || 'Customer'}! Your order #${toolJSON.args.order_number} contains: ${itemsList}. Status: ${data.status}. ${fulfillmentMsg}`
            });
        }

        // --- For non-order messages, try tool selection via app.py ---
        if (!toolJSON) {
            const toolPrompt = `
You are a support assistant. Decide which tool is needed for this user request.
Available tools:
- get_order_status(order_number)
- get_return_policy()
- get_delivery_estimate(order_number)
- none() — use this if no tool is needed (e.g. greetings, general questions, product questions)

Respond ONLY in valid JSON, no explanation:
{
  "tool": "<tool_name>",
  "args": { ... }
}

User message: "${message}"
`;
            const toolResponse = await axios.post(`${PHI3_BACKEND}/chat`, { message: toolPrompt });

            try {
                toolJSON = extractJSON(toolResponse.data.response);
            } catch (parseErr) {
                console.log("Tool selection unclear, falling back to conversation.");
                const reply = await getConversationalReply(message);
                return res.json({ answer: reply });
            }
        }

        // --- If model picked "none", reply conversationally with product context ---
        if (!toolJSON || toolJSON.tool === 'none') {
            const reply = await getConversationalReply(message);
            return res.json({ answer: reply });
        }

        // --- Call the selected tool ---
        let toolResult;
        if (toolJSON.tool === 'get_return_policy') {
            const r = await axios.post(`${SHOPIFY_BACKEND}/return_policy`, toolJSON.args || {});
            toolResult = r.data;
        } else if (toolJSON.tool === 'get_delivery_estimate') {
            const r = await axios.post(`${SHOPIFY_BACKEND}/delivery_estimate`, toolJSON.args || {});
            toolResult = r.data;
        } else if (toolJSON.tool === 'get_order_status') {
            const r = await axios.post(`${SHOPIFY_BACKEND}/order_status`, toolJSON.args || {});
            toolResult = r.data;
        } else {
            const reply = await getConversationalReply(message);
            return res.json({ answer: reply });
        }

        // --- Generate final response from app.py ---
        const finalPrompt = `
You are a helpful support assistant for a luxury car store.
The system retrieved this information: ${JSON.stringify(toolResult)}
Respond with a clear, concise, polite message for the customer.
Do NOT include JSON or code in your reply.
Customer question: "${message}"
`;
        const finalResponse = await axios.post(`${PHI3_BACKEND}/chat`, { message: finalPrompt });
        res.json({ answer: finalResponse.data.response.trim() });

    } catch (err) {
        console.error("Error:", err.message);
        res.status(500).json({ error: 'Something went wrong', details: err.message });
    }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
    console.log(`AI backend running on port ${PORT}`);
});