from fastapi import FastAPI
from pydantic import BaseModel
import requests
import os
from dotenv import load_dotenv
from langdetect import detect, LangDetectException

load_dotenv()

app = FastAPI()

HF_API_KEY = os.getenv("HF_API_KEY")

HF_API_URL = "https://router.huggingface.co/v1/chat/completions"

HEADERS = {
    "Authorization": f"Bearer {HF_API_KEY}",
    "Content-Type": "application/json"
}

SYSTEM_PROMPT = """You are a helpful customer support assistant for an online store that sells luxury cars and automotive products.

Store details:
- We sell premium vehicles and car accessories
- Orders are typically fulfilled within 7 days
- We accept returns on fulfilled, unused orders
- For order tracking, customers must provide their order number (e.g. #1001)
- All prices are in PKR (Pakistani Rupees)

Formatting rules:
- When listing products, always put each one on a separate line
- Use this format for products: "• Product Name — PKR Price"
- Keep responses short and to the point
- Do not write long paragraphs
- Do not add unnecessary filler sentences

Language rules:
- ALWAYS detect the language the customer is writing in
- ALWAYS respond in the same language the customer used
- If the customer writes in Urdu, reply in Urdu
- If the customer writes in Arabic, reply in Arabic
- If the customer writes in any other language, reply in that same language
- Only use English if the customer writes in English

Be friendly, concise, and helpful.
Do NOT make up order details — those are handled separately by our order system.
Answer general questions about the store, products, and policies naturally."""

# Map of langdetect language codes to full language names
# Used to explicitly tell the LLM which language to respond in
LANGUAGE_NAMES = {
    "en": "English",
    "ur": "Urdu",
    "ar": "Arabic",
    "fr": "French",
    "es": "Spanish",
    "de": "German",
    "zh-cn": "Chinese",
    "zh-tw": "Chinese",
    "hi": "Hindi",
    "pt": "Portuguese",
    "ru": "Russian",
    "ja": "Japanese",
    "ko": "Korean",
    "tr": "Turkish",
    "it": "Italian",
    "nl": "Dutch",
    "pl": "Polish",
    "fa": "Persian",
    "bn": "Bengali",
}

def detect_language(text: str) -> tuple:
    """
    Detect the language of the input text.
    Returns a tuple of (language_code, language_name).
    Falls back to English if detection fails.
    """
    try:
        code = detect(text)
        name = LANGUAGE_NAMES.get(code, "English")
        return code, name
    except LangDetectException:
        return "en", "English"

class ChatRequest(BaseModel):
    message: str

@app.post("/chat")
def chat(req: ChatRequest):

    # --- Detect the language of the customer's message ---
    lang_code, lang_name = detect_language(req.message)
    print(f"[Language detected: {lang_name} ({lang_code})]")

    # --- Build a language-aware system prompt ---
    # If not English, add an explicit instruction to reply in the detected language.
    # This ensures the LLM does not default back to English.
    if lang_code != "en":
        language_instruction = f"\n\nCRITICAL: The customer is writing in {lang_name}. You MUST respond entirely in {lang_name}. Do not use English in your response."
        system_prompt = SYSTEM_PROMPT + language_instruction
    else:
        system_prompt = SYSTEM_PROMPT

    payload = {
        "model": "meta-llama/Llama-3.1-8B-Instruct:cerebras",
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": req.message}
        ],
        "max_tokens": 400,
        "temperature": 0.4
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

@app.get("/health")
def health():
    return {"status": "HF-powered AI backend running"}