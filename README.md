# ECS Sample Application

Sample backend + frontend application for deploying to **Amazon ECS with Application Load Balancer**.

## Project Structure

```
├── backend/
│   ├── server.js          # Express API server
│   ├── package.json
│   ├── Dockerfile
│   └── .dockerignore
├── frontend/
│   ├── index.html         # Dashboard UI
│   ├── styles.css
│   ├── app.js
│   ├── nginx.conf         # Nginx config (proxy + static files)
│   ├── Dockerfile
│   └── .dockerignore
├── ecs/
│   ├── backend-task-definition.json
│   └── frontend-task-definition.json
├── docker-compose.yml     # Local testing
├── deploy.sh              # Full AWS deployment script
├── cleanup.sh             # Tear down all resources
└── README.md
```

## Quick Start (Local)

```bash
docker-compose up --build
# Frontend: http://localhost
# Backend:  http://localhost:3000/api/health
```

## Deploy to AWS ECS

```bash
# 1. Configure AWS CLI
aws configure

# 2. Run deployment
chmod +x deploy.sh
./deploy.sh
```

## Cleanup

```bash
chmod +x cleanup.sh
./cleanup.sh
```
