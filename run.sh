source .venv/bin/activate

gcloud auth login
gcloud auth application-default login

tmux new -s sh 'uv run main.py'

echo "Access via http://localhost:8001/live-smarthome-agent/v2"
