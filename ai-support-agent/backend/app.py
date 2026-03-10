from fastapi import FastAPI
from pydantic import BaseModel
import requests
import os
from dotenv import load_dotenv

load_dotenv()

app = FastAPI()

HF_API_KEY = os.getenv("HF_API_KEY")

# Correct HF router URL — /v1 base, model+provider in the request body
HF_API_URL = "https://router.huggingface.co/v1/chat/completions"

HEADERS = {
    "Authorization": f"Bearer {HF_API_KEY}",
    "Content-Type": "application/json"
}

# Edit this to match your actual store details
SYSTEM_PROMPT = """You are a helpful customer support assistant for an online store that sells luxury cars and automotive products.

Store details:
- We sell premium vehicles and car accessories
- Orders are typically fulfilled within 7 days
- We accept returns on fulfilled, unused orders
- For order tracking, customers must provide their order number (e.g. #1001)

Be friendly, concise, and helpful. 
Do NOT make up order details — those are handled separately by our order system.
Answer general questions about the store, products, and policies naturally."""

class ChatRequest(BaseModel):
    message: str

@app.post("/chat")
def chat(req: ChatRequest):
    payload = {
        "model": "meta-llama/Llama-3.1-8B-Instruct:cerebras",  # free + fast via Cerebras provider
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": req.message}
        ],
        "max_tokens": 300,
        "temperature": 0.5
    }

    response = requests.post(HF_API_URL, headers=HEADERS, json=payload)

    if response.status_code != 200:
        print(f"HF API error {response.status_code}: {response.text}")
        return {"response": "I'm sorry, I'm having trouble responding right now. Please try again shortly."}

    data = response.json()

    try:
        reply = data["choices"][0]["message"]["content"].strip()
        return {"response": reply}
    except (KeyError, IndexError) as e:
        print(f"Unexpected HF response format: {data}")
        return {"response": "I'm sorry, something went wrong. Please try again."}

# --- Health check ---
@app.get("/health")
def health():
    return {"status": "HF-powered AI backend running"}
