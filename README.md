# live-smarthome-agent #

### 1) Prework
Ensure following baseline roles are added to the account on a fresh run\
(setup.sh will verify these and automatically grant the remaining operator roles):
  - Project IAM Admin (roles/resourcemanager.projectIamAdmin)
  - Service Usage Admin (roles/serviceusage.serviceUsageAdmin)\
Edit the .env file (changing <project_id>)

### 2) Setup the infra, IAM, etc
```bash
bash setup.sh
```

### 3) Create a virtual environment and install dependencies
```bash
uv venv
source .venv/bin/activate
uv pip install -r requirements.txt
```

### 4a) Start the server (active)
```bash
uv run main.py
```

### 4b) Start the server (in background)
```bash
tmux new-session -d -s smarthome 'uv run main.py'
tmux attach-session -t smarthome
```

### 5) Access via these URLs
http://localhost:8001/live-smarthome-agent               # Main Voice & Smart Home UI 
http://localhost:8001/live-smarthome-agent/initialize    # Admin / Firestore Initializer	
http://localhost:8001/live-smarthome-agent/camview	     # Camera Feed Viewer
