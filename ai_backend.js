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

// ============================================================
// PRODUCTS CACHE (refreshes every 10 minutes)
// ============================================================
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

// ============================================================
// FEATURE 1 — INTENT DETECTION
// Replaces the old autoSelectTool() with a richer classifier
// covering 8 intents instead of just 3.
// ============================================================
function detectIntent(message) {
    const lower = message.toLowerCase();

    // Order status — must have an actual order number
    if (lower.includes("order") || lower.includes("where is my") || lower.includes("track")) {
        const orderNumber = extractOrderNumber(message);
        if (orderNumber) return { intent: "order_status", orderNumber };
    }

    // Return / refund
    if (lower.includes("return") || lower.includes("refund") || lower.includes("exchange")) {
        return { intent: "return_refund" };
    }

    // Delivery / shipping
    if (lower.includes("delivery") || lower.includes("shipping") || lower.includes("arrive") || lower.includes("when will")) {
        return { intent: "delivery_shipping" };
    }

    // Product comparison — "vs", "compare", "difference between", "which is better"
    if (lower.includes(" vs ") || lower.includes("compare") || lower.includes("difference between") || lower.includes("which is better") || lower.includes("versus")) {
        return { intent: "product_comparison" };
    }

    // Product recommendation — "suggest", "recommend", "help me choose"
    if (lower.includes("suggest") || lower.includes("recommend") || lower.includes("which one should") || lower.includes("best") || lower.includes("what should i buy") || lower.includes("help me choose") || lower.includes("which car")) {
        return { intent: "product_recommendation" };
    }

    // Complaint — frustration keywords
    if (lower.includes("complaint") || lower.includes("terrible") || lower.includes("worst") || lower.includes("angry") || lower.includes("frustrated") || lower.includes("unacceptable") || lower.includes("disappointed") || lower.includes("horrible")) {
        return { intent: "complaint" };
    }

    // Price concern — hesitation about price
    if (lower.includes("too expensive") || lower.includes("cheaper") || lower.includes("discount") || lower.includes("price is high") || lower.includes("can't afford") || lower.includes("any deals") || lower.includes("any offers") || lower.includes("negotiate")) {
        return { intent: "price_concern" };
    }

    return { intent: "general" };
}

// ============================================================
// FEATURE 2 — SENTIMENT ANALYSIS
// Keyword-based — no external API needed, runs instantly.
// Returns: "negative", "positive", or "neutral"
// Passed into getConversationalReply() to adjust tone.
// ============================================================
function detectSentiment(message) {
    const lower = message.toLowerCase();

    const negativeWords = [
        "terrible", "horrible", "worst", "angry", "frustrated", "unacceptable",
        "disappointed", "useless", "awful", "disgusting", "ridiculous", "scam",
        "cheated", "waste", "regret", "never again", "bad experience",
        "poor service", "not happy", "very upset", "hate"
    ];
    const positiveWords = [
        "great", "amazing", "excellent", "love", "fantastic", "happy",
        "satisfied", "perfect", "awesome", "wonderful", "thank you",
        "appreciate", "brilliant", "superb", "impressive"
    ];

    const negativeCount = negativeWords.filter(w => lower.includes(w)).length;
    const positiveCount = positiveWords.filter(w => lower.includes(w)).length;

    if (negativeCount > 0) return "negative";
    if (positiveCount > 0) return "positive";
    return "neutral";
}

// ============================================================
// FEATURE 3 — PRODUCT COMPARISON
// Matches products mentioned in the message to the catalog,
// builds a structured comparison. Falls back to AI if needed.
// ============================================================
async function handleProductComparison(message) {
    const products = await getProducts();

    if (!products || !products.length) {
        return "I'm sorry, I couldn't load the product catalog right now. Please try again shortly.";
    }

    const lower = message.toLowerCase();

    // Try to directly match products mentioned in the message
    const matched = products.filter(p =>
        lower.includes(p.title.toLowerCase()) ||
        p.title.toLowerCase().split(' ').some(word => word.length > 4 && lower.includes(word))
    );

    if (matched.length >= 2) {
        // Build structured comparison from matched products
        const lines = matched.map(p =>
            `• ${p.title}\n  Price: PKR ${p.price}\n  Type: ${p.type || 'Luxury Car'}\n  Vendor: ${p.vendor || 'N/A'}`
        ).join('\n\n');
        return `Here is a comparison of the products you asked about:\n\n${lines}\n\nWould you like more details about any of these?`;
    }

    // Fallback: let the AI figure out which products to compare
    const productList = products.map(p => `- ${p.title} (${p.type || 'Luxury Car'}) — PKR ${p.price}`).join('\n');
    const prompt = `You are a luxury car store assistant. A customer wants to compare products.

Available products:
${productList}

Customer message: "${message}"

Identify the products the customer wants to compare from the list above.
Provide a clear, structured comparison covering price, type, and best use case.
Only reference products from the list. Keep it concise and helpful.`;

    const response = await axios.post(`${PHI3_BACKEND}/chat`, { message: prompt });
    return response.data.response?.trim() || "I couldn't identify specific products to compare. Could you mention the exact product names?";
}

// ============================================================
// FEATURE 4 — PRODUCT RECOMMENDATION
// Passes full product catalog + customer message to the AI
// so it can suggest the most suitable product(s).
// ============================================================
async function handleProductRecommendation(message) {
    const products = await getProducts();
    const productList = products.length
        ? products.map(p => `- ${p.title} (${p.type || 'Luxury Car'}) — PKR ${p.price}`).join('\n')
        : 'Product list currently unavailable.';

    const prompt = `You are a luxury car store assistant helping a customer choose the right vehicle.

Available products:
${productList}

Customer message: "${message}"

Based on what the customer is looking for, recommend the most suitable product(s) from the list above.
Explain briefly why each recommendation fits their needs.
Only recommend products from the list. Keep the response friendly and concise.`;

    const response = await axios.post(`${PHI3_BACKEND}/chat`, { message: prompt });
    return response.data.response?.trim() || "I'm having trouble generating recommendations right now. Please try again.";
}

// ============================================================
// CONVERSATIONAL REPLY — general fallback
// Now sentiment-aware: tone adjusts based on customer mood.
// ============================================================
async function getConversationalReply(message, sentiment = "neutral") {
    const products = await getProducts();
    const productList = products.length
        ? products.map(p => `- ${p.title} (${p.type || 'Luxury Car'}) — PKR ${p.price}`).join('\n')
        : 'Product list currently unavailable.';

    const sentimentNote = sentiment === "negative"
        ? "\nIMPORTANT: The customer seems frustrated or upset. Respond with extra empathy, apologize sincerely, and offer to escalate to a human support agent if needed.\n"
        : sentiment === "positive"
            ? "\nThe customer seems happy. Match their positive energy and be warm and enthusiastic.\n"
            : "";

    const prompt = `You are a helpful customer support assistant for a luxury car store.
${sentimentNote}
Current products listed on the store:
${productList}

Store policies:
- Orders are fulfilled within 7 days
- Returns are accepted on fulfilled, unused orders
- For order tracking, customers must provide their order number (e.g. #1001)
- All prices are in PKR (Pakistani Rupees)

Answer the customer's question naturally and helpfully using the above information.
Do NOT make up products or prices that are not listed above.
Customer message: "${message}"`;

    const response = await axios.post(`${PHI3_BACKEND}/chat`, { message: prompt });
    return response.data.response?.trim() || "I'm not sure how to help with that. Could you rephrase?";
}

// ============================================================
// MAIN /ask ENDPOINT
// Flow: detect intent → detect sentiment → route to handler
// ============================================================
app.post('/ask', async (req, res) => {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: "Message is required" });

    try {
        // Step 1: Detect intent and sentiment
        const { intent, orderNumber } = detectIntent(message);
        const sentiment = detectSentiment(message);

        console.log(`[Intent: ${intent}] [Sentiment: ${sentiment}] "${message}"`);

        // Step 2: Route based on intent

        // ORDER STATUS
        if (intent === "order_status" && orderNumber) {
            const r = await axios.post(`${SHOPIFY_BACKEND}/order_status`, { order_number: orderNumber });
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
                answer: `Hello ${data.customer_name || 'Customer'}! Your order #${orderNumber} contains: ${itemsList}. Status: ${data.status}. ${fulfillmentMsg}`
            });
        }

        // RETURN / REFUND
        if (intent === "return_refund") {
            const r = await axios.post(`${SHOPIFY_BACKEND}/return_policy`, {});
            const finalPrompt = `You are a helpful support assistant for a luxury car store.
The return policy info: ${JSON.stringify(r.data)}
Respond clearly and politely about the return/refund policy.
Customer question: "${message}"`;
            const finalResponse = await axios.post(`${PHI3_BACKEND}/chat`, { message: finalPrompt });
            return res.json({ answer: finalResponse.data.response.trim() });
        }

        // DELIVERY / SHIPPING
        if (intent === "delivery_shipping") {
            const r = await axios.post(`${SHOPIFY_BACKEND}/delivery_estimate`, {});
            const finalPrompt = `You are a helpful support assistant for a luxury car store.
Delivery estimate info: ${JSON.stringify(r.data)}
Answer the customer's delivery/shipping question clearly.
Customer question: "${message}"`;
            const finalResponse = await axios.post(`${PHI3_BACKEND}/chat`, { message: finalPrompt });
            return res.json({ answer: finalResponse.data.response.trim() });
        }

        // PRODUCT COMPARISON (NEW)
        if (intent === "product_comparison") {
            const reply = await handleProductComparison(message);
            return res.json({ answer: reply });
        }

        // PRODUCT RECOMMENDATION (NEW)
        if (intent === "product_recommendation") {
            const reply = await handleProductRecommendation(message);
            return res.json({ answer: reply });
        }

        // COMPLAINT — force negative sentiment tone
        if (intent === "complaint") {
            const reply = await getConversationalReply(message, "negative");
            return res.json({ answer: reply });
        }

        // PRICE CONCERN — empathetic, highlight value
        if (intent === "price_concern") {
            const products = await getProducts();
            const productList = products.map(p => `- ${p.title} — PKR ${p.price}`).join('\n');
            const prompt = `You are a luxury car store assistant. A customer has a concern about pricing.

Available products and prices:
${productList}

Acknowledge their concern empathetically. Highlight the quality and exclusivity of the products.
Mention that they can contact support for any special inquiries.
Customer message: "${message}"`;
            const response = await axios.post(`${PHI3_BACKEND}/chat`, { message: prompt });
            return res.json({ answer: response.data.response?.trim() });
        }

        // GENERAL — conversational fallback, now fully sentiment-aware (NEW)
        const reply = await getConversationalReply(message, sentiment);
        return res.json({ answer: reply });

    } catch (err) {
        console.error("Error:", err.message);
        res.status(500).json({ error: 'Something went wrong', details: err.message });
    }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
    console.log(`AI backend running on port ${PORT}`);
});