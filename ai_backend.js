const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const path = require('path');

const app = express();
app.use(bodyParser.json());

// --- Serve static frontend files ---
app.use(express.static(path.join(__dirname, 'public')));

const SHOPIFY_BACKEND = process.env.SHOPIFY_BACKEND_URL || 'http://localhost:3000';  // Shopify backend
const PHI3_BACKEND = process.env.PHI3_BACKEND_URL || 'http://localhost:8000';    // Phi3 AI backend

// --- Helper: extract first JSON object from Phi3 response ---
function extractJSON(text) {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('Failed to extract JSON from Phi3 response');
    return JSON.parse(match[0]);
}

// --- Helper: extract order number from user message ---
function extractOrderNumber(message) {
    const match = message.match(/#?(\d{3,})/);  // Matches #1001 or 1001
    return match ? match[1] : null;
}

// --- Shortcut for common queries (faster response) ---
function autoSelectTool(message) {
    message = message.toLowerCase();

    // Order queries
    if (message.includes("order") || message.includes("where is my order") || message.includes("status")) {
        const orderNumber = extractOrderNumber(message);
        if (orderNumber) return { tool: "get_order_status", args: { order_number: orderNumber } };
    }

    // Return/refund queries
    if (message.includes("return") || message.includes("refund")) {
        return { tool: "get_return_policy", args: {} };
    }

    // Delivery/shipping queries
    if (message.includes("delivery") || message.includes("shipping")) {
        return { tool: "get_delivery_estimate", args: {} };
    }

    return null; // fallback to Phi3 for general queries
}

app.post('/ask', async (req, res) => {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: "Message is required" });

    try {
        let toolJSON = autoSelectTool(message);

        // --- Order queries shortcut ---
        if (toolJSON && toolJSON.tool === 'get_order_status') {
            const r = await axios.post(`${SHOPIFY_BACKEND}/order_status`, toolJSON.args || {});
            const data = r.data;

            if (!data.found) {
                return res.json({
                    answer: "I’m sorry, I couldn’t find updates for your order right now. Please try again later or contact support. Thank you!"
                });
            }

            // Prepare items list
            const itemsList = data.items
                ? data.items.map(i => `${i.quantity} x ${i.title}`).join(", ")
                : "Items info unavailable";

            // Fulfillment message
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
            } else { // unfulfilled
                // get estimated delivery
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

        // --- For other queries, use Phi3 to decide tool ---
        if (!toolJSON) {
            const toolPrompt = `
You are a support assistant.
Decide which tool is required for this user request:
- get_order_status(order_number)
- get_return_policy()
- get_delivery_estimate(order_number)

Respond ONLY in valid JSON format like:
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
                console.error("Failed to parse Phi3 tool response:", toolResponse.data.response);
                return res.status(500).json({ error: "Failed to parse tool selection from Phi3" });
            }
        }

        // --- Call the selected tool ---
        let toolResult;
        if (toolJSON.tool === 'get_return_policy') {
            const r = await axios.post(`${SHOPIFY_BACKEND}/return_policy`, toolJSON.args || {});
            toolResult = r.data;
        } else if (toolJSON.tool === 'get_delivery_estimate') {
            const r = await axios.post(`${SHOPIFY_BACKEND}/delivery_estimate`, toolJSON.args || {});
            toolResult = r.data;
        } else {
            toolResult = { error: "Unknown tool" };
        }

        // --- Generate final Phi3 response ---
        const finalPrompt = `
You are a helpful support assistant.
The tool returned this result:
${JSON.stringify(toolResult)}

Respond ONLY with a clear, concise, polite message for the user.
Do NOT include JSON, code, or extra instructions.
User question: "${message}"
`;
        const finalResponse = await axios.post(`${PHI3_BACKEND}/chat`, { message: finalPrompt });

        res.json({ answer: finalResponse.data.response.trim() });

    } catch (err) {
        console.error("AI backend error:", err);
        res.status(500).json({ error: 'AI processing failed', details: err.message });
    }
});

// --- Start AI server ---
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
    console.log(`AI backend running on port ${PORT}`);
});