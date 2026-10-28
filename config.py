import os
from dotenv import load_dotenv

import logging

logger = logging.getLogger(__name__)

# Load environment variables early
load_dotenv(override=True)

class AgentConfig:
    """
    Manages environment-based routing between Gemini AI Studio 
    and Vertex AI models dynamically for the Live Translator.
    """
    def __init__(self):
        
        self.GCP_PROJECT_ID = os.getenv(
            "GOOGLE_CLOUD_PROJECT",
            "missing-gcp-project-id"
        )
        
        if os.getenv("GOOGLE_GENAI_USE_VERTEXAI", "true").lower() == "false":
            
            logger.info("Need to route to GEMINI API (Google AI Studio).")
            
            self.ORCHESTRATOR_MODEL = os.getenv(
                "LIVEAGENT_GEMINI_MODEL", 
                "gemini-3.1-flash-live-preview"
            )            
            
            self.IS_VERTEX_AI_LIVE_API = False
            
        else:
            logger.info("Need to route to VERTEX AI API.")
            
            self.ORCHESTRATOR_MODEL = os.getenv(
                "LIVEAGENT_VERTEXAI_MODEL", 
                "gemini-live-2.5-flash-native-audio"
            )
            
            self.IS_VERTEX_AI_LIVE_API = True
            
        self.SUBAGENT_MODEL = os.getenv(
            "SUBAGENT_LITE_MODEL", 
            "gemini-3.1-flash-lite"
        )
        
        self.SUBAGENT_CLOUD_LOCATION = os.getenv(
            "SUBAGENT_LITE_CLOUD_LOCATION", 
            "global"
        )

        # Agent architecture default for WebSocket sessions that don't pass ?arch=
        #   "monolithic" -> Live agent owns all rules + 6 tools (original behaviour, v1 default)
        #   "brain"      -> thin Live voice layer + cacheable Flash Lite brain (brain.py)
        self.AGENT_ARCH_DEFAULT = os.getenv("SMARTHOME_AGENT_ARCH", "monolithic").strip().lower()

        # Brain sub-agent (generateContent + function calling, implicit caching)
        self.BRAIN_MODEL = os.getenv("BRAIN_MODEL", self.SUBAGENT_MODEL)
        self.BRAIN_CLOUD_LOCATION = os.getenv("BRAIN_CLOUD_LOCATION", self.SUBAGENT_CLOUD_LOCATION)
        self.BRAIN_MAX_STEPS = int(os.getenv("BRAIN_MAX_STEPS", "6"))
        
        logger.info(f"INITAILIZATION COMPLETE with ORCHESTRATOR_MODEL {self.ORCHESTRATOR_MODEL}; IS_VERTEX_AI_LIVE_API {self.IS_VERTEX_AI_LIVE_API}; SUBAGENT_MODEL {self.SUBAGENT_MODEL}; SUBAGENT_CLOUD_LOCATION {self.SUBAGENT_CLOUD_LOCATION}; AGENT_ARCH_DEFAULT {self.AGENT_ARCH_DEFAULT}; BRAIN_MODEL {self.BRAIN_MODEL}; BRAIN_CLOUD_LOCATION {self.BRAIN_CLOUD_LOCATION};")

# App Configuration
APP_NAME = "aris_smarthome_agent"

# Initialize a singleton configuration object for importing across the app
agent_config = AgentConfig()