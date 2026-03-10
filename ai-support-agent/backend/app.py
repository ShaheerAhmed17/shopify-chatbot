from fastapi import FastAPI
from pydantic import BaseModel
import requests

app = FastAPI()

OLLAMA_URL = "http://localhost:11434/api/generate"

class ChatRequest(BaseModel):
    message: str

@app.post("/chat")
def chat(req: ChatRequest):
    response = requests.post(
        OLLAMA_URL,
        json={
            "model": "phi3",
            "prompt": req.message,
            "stream": False
        }
    )
    data = response.json()

    # Ensure always returning string response
    return {
        "response": data.get("response", "")
    }