#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════
# ECS Deployment Script - "test" Service with SigNoz Logging
# ═══════════════════════════════════════════════════════════════════════
#
# PREREQUISITES:
#   1. AWS CLI v2 installed and configured (aws configure)
#   2. Docker installed and running
#   3. Sufficient IAM permissions
#
# USAGE:
#   chmod +x deploy.sh
#   ./deploy.sh
#
# ═══════════════════════════════════════════════════════════════════════

set -euo pipefail

# Prevent Git Bash on Windows from converting absolute paths like /api/health
export MSYS_NO_PATHCONV=1

# ─── Configuration (EDIT THESE) ───────────────────────────────────────
AWS_REGION="ap-south-1"           # Change to your preferred region
CLUSTER_NAME="test-cluster"
BACKEND_REPO="test-backend"
FRONTEND_REPO="test-frontend"
VPC_ID=""                          # Will be auto-detected if empty
SUBNET_IDS=""                      # Comma-separated, auto-detected if empty
ALB_NAME="test-alb"
BACKEND_TG_NAME="test-backend-tg"
FRONTEND_TG_NAME="test-frontend-tg"
DESIRED_COUNT=2                    # Number of tasks per service

# SigNoz Configuration
SIGNOZ_ENDPOINT="https://signoz.decodeage.in"
# SIGNOZ_ACCESS_TOKEN=""           # Uncomment if your SigNoz requires a token

# ─── Colors ───────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

log_info()  { echo -e "${BLUE}[INFO]${NC} $1"; }
log_ok()    { echo -e "${GREEN}[OK]${NC} $1"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }
log_step()  { echo -e "\n${CYAN}═══ Step $1: $2 ═══${NC}"; }

# ─── Get AWS Account ID ──────────────────────────────────────────────
ACCOUNT_ID=$(aws sts get-caller-identity --query "Account" --output text)
ECR_URI="${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"
log_info "AWS Account: ${ACCOUNT_ID}"
log_info "ECR URI: ${ECR_URI}"
log_info "Region: ${AWS_REGION}"
log_info "SigNoz Endpoint: ${SIGNOZ_ENDPOINT}"

# ═══════════════════════════════════════════════════════════════════════
# Step 1: Create ECR Repositories
# ═══════════════════════════════════════════════════════════════════════
log_step "1" "Creating ECR Repositories"

for REPO in $BACKEND_REPO $FRONTEND_REPO; do
  if aws ecr describe-repositories --repository-names "$REPO" --region "$AWS_REGION" 2>/dev/null; then
    log_ok "Repository '$REPO' already exists"
  else
    aws ecr create-repository --repository-name "$REPO" --region "$AWS_REGION" \
      --image-scanning-configuration scanOnPush=true
    log_ok "Created repository '$REPO'"
  fi
done

# ═══════════════════════════════════════════════════════════════════════
# Step 2: Build & Push Docker Images
# ═══════════════════════════════════════════════════════════════════════
log_step "2" "Building & Pushing Docker Images"

# Login to ECR
aws ecr get-login-password --region "$AWS_REGION" | \
  docker login --username AWS --password-stdin "$ECR_URI"
log_ok "Logged in to ECR"

# Build and push backend
log_info "Building backend image..."
docker build -t "${BACKEND_REPO}:latest" ./backend/
docker tag "${BACKEND_REPO}:latest" "${ECR_URI}/${BACKEND_REPO}:latest"
docker push "${ECR_URI}/${BACKEND_REPO}:latest"
log_ok "Backend image pushed to ECR"

# Build and push frontend
log_info "Building frontend image..."
docker build -t "${FRONTEND_REPO}:latest" ./frontend/
docker tag "${FRONTEND_REPO}:latest" "${ECR_URI}/${FRONTEND_REPO}:latest"
docker push "${ECR_URI}/${FRONTEND_REPO}:latest"
log_ok "Frontend image pushed to ECR"

# ═══════════════════════════════════════════════════════════════════════
# Step 3: Create ECS Cluster
# ═══════════════════════════════════════════════════════════════════════
log_step "3" "Creating ECS Cluster"

if aws ecs describe-clusters --clusters "$CLUSTER_NAME" --region "$AWS_REGION" \
    --query "clusters[?status=='ACTIVE'].clusterName" --output text | grep -q "$CLUSTER_NAME"; then
  log_ok "Cluster '$CLUSTER_NAME' already exists"
else
  aws ecs create-cluster --cluster-name "$CLUSTER_NAME" --region "$AWS_REGION"
  log_ok "Created cluster '$CLUSTER_NAME'"
fi

# ═══════════════════════════════════════════════════════════════════════
# Step 4: Auto-detect VPC & Subnets
# ═══════════════════════════════════════════════════════════════════════
log_step "4" "Detecting VPC & Subnets"

if [ -z "$VPC_ID" ]; then
  VPC_ID=$(aws ec2 describe-vpcs --filters "Name=isDefault,Values=true" \
    --query "Vpcs[0].VpcId" --output text --region "$AWS_REGION")
  log_info "Auto-detected default VPC: $VPC_ID"
fi

if [ -z "$SUBNET_IDS" ]; then
  SUBNET_IDS=$(aws ec2 describe-subnets --filters "Name=vpc-id,Values=$VPC_ID" \
    --query "Subnets[?MapPublicIpOnLaunch==\`true\`].SubnetId" --output text --region "$AWS_REGION" \
    | tr '\t' ',')
  log_info "Auto-detected subnets: $SUBNET_IDS"
fi

# Convert to array
IFS=',' read -ra SUBNET_ARRAY <<< "$SUBNET_IDS"

# ═══════════════════════════════════════════════════════════════════════
# Step 5: Create Security Groups
# ═══════════════════════════════════════════════════════════════════════
log_step "5" "Creating Security Groups"

# ALB Security Group
ALB_SG_ID=$(aws ec2 describe-security-groups \
  --filters "Name=group-name,Values=test-alb-sg" "Name=vpc-id,Values=$VPC_ID" \
  --query "SecurityGroups[0].GroupId" --output text --region "$AWS_REGION" 2>/dev/null)

if [ "$ALB_SG_ID" == "None" ] || [ -z "$ALB_SG_ID" ]; then
  ALB_SG_ID=$(aws ec2 create-security-group \
    --group-name test-alb-sg \
    --description "Security group for test ALB" \
    --vpc-id "$VPC_ID" \
    --query "GroupId" --output text --region "$AWS_REGION")

  aws ec2 authorize-security-group-ingress --group-id "$ALB_SG_ID" \
    --protocol tcp --port 80 --cidr 0.0.0.0/0 --region "$AWS_REGION"
  aws ec2 authorize-security-group-ingress --group-id "$ALB_SG_ID" \
    --protocol tcp --port 443 --cidr 0.0.0.0/0 --region "$AWS_REGION"
  log_ok "Created ALB Security Group: $ALB_SG_ID"
else
  log_ok "ALB Security Group already exists: $ALB_SG_ID"
fi

# ECS Security Group (only accept traffic from ALB)
ECS_SG_ID=$(aws ec2 describe-security-groups \
  --filters "Name=group-name,Values=test-ecs-sg" "Name=vpc-id,Values=$VPC_ID" \
  --query "SecurityGroups[0].GroupId" --output text --region "$AWS_REGION" 2>/dev/null)

if [ "$ECS_SG_ID" == "None" ] || [ -z "$ECS_SG_ID" ]; then
  ECS_SG_ID=$(aws ec2 create-security-group \
    --group-name test-ecs-sg \
    --description "Security group for test ECS tasks" \
    --vpc-id "$VPC_ID" \
    --query "GroupId" --output text --region "$AWS_REGION")

  aws ec2 authorize-security-group-ingress --group-id "$ECS_SG_ID" \
    --protocol tcp --port 0-65535 --source-group "$ALB_SG_ID" --region "$AWS_REGION"
  log_ok "Created ECS Security Group: $ECS_SG_ID"
else
  log_ok "ECS Security Group already exists: $ECS_SG_ID"
fi

# ═══════════════════════════════════════════════════════════════════════
# Step 6: Create Application Load Balancer
# ═══════════════════════════════════════════════════════════════════════
log_step "6" "Creating Application Load Balancer"

ALB_ARN=$(aws elbv2 describe-load-balancers --names "$ALB_NAME" \
  --query "LoadBalancers[0].LoadBalancerArn" --output text --region "$AWS_REGION" 2>/dev/null || echo "")

if [ -z "$ALB_ARN" ] || [ "$ALB_ARN" == "None" ]; then
  ALB_ARN=$(aws elbv2 create-load-balancer \
    --name "$ALB_NAME" \
    --subnets ${SUBNET_ARRAY[@]} \
    --security-groups "$ALB_SG_ID" \
    --scheme internet-facing \
    --type application \
    --query "LoadBalancers[0].LoadBalancerArn" --output text --region "$AWS_REGION")
  log_ok "Created ALB: $ALB_ARN"
else
  log_ok "ALB already exists: $ALB_ARN"
fi

ALB_DNS=$(aws elbv2 describe-load-balancers --load-balancer-arns "$ALB_ARN" \
  --query "LoadBalancers[0].DNSName" --output text --region "$AWS_REGION")
log_info "ALB DNS: $ALB_DNS"

# ═══════════════════════════════════════════════════════════════════════
# Step 7: Create Target Groups
# ═══════════════════════════════════════════════════════════════════════
log_step "7" "Creating Target Groups"

# Backend Target Group
BACKEND_TG_ARN=$(aws elbv2 describe-target-groups --names "$BACKEND_TG_NAME" \
  --query "TargetGroups[0].TargetGroupArn" --output text --region "$AWS_REGION" 2>/dev/null || echo "")

if [ -z "$BACKEND_TG_ARN" ] || [ "$BACKEND_TG_ARN" == "None" ]; then
  BACKEND_TG_ARN=$(aws elbv2 create-target-group \
    --name "$BACKEND_TG_NAME" \
    --protocol HTTP \
    --port 3000 \
    --target-type ip \
    --vpc-id "$VPC_ID" \
    --health-check-path "/api/health" \
    --health-check-interval-seconds 30 \
    --health-check-timeout-seconds 5 \
    --healthy-threshold-count 2 \
    --unhealthy-threshold-count 3 \
    --query "TargetGroups[0].TargetGroupArn" --output text --region "$AWS_REGION")
  log_ok "Created Backend Target Group: $BACKEND_TG_ARN"
else
  log_ok "Backend Target Group already exists: $BACKEND_TG_ARN"
fi

# Frontend Target Group
FRONTEND_TG_ARN=$(aws elbv2 describe-target-groups --names "$FRONTEND_TG_NAME" \
  --query "TargetGroups[0].TargetGroupArn" --output text --region "$AWS_REGION" 2>/dev/null || echo "")

if [ -z "$FRONTEND_TG_ARN" ] || [ "$FRONTEND_TG_ARN" == "None" ]; then
  FRONTEND_TG_ARN=$(aws elbv2 create-target-group \
    --name "$FRONTEND_TG_NAME" \
    --protocol HTTP \
    --port 80 \
    --target-type ip \
    --vpc-id "$VPC_ID" \
    --health-check-path "/nginx-health" \
    --health-check-interval-seconds 30 \
    --health-check-timeout-seconds 5 \
    --healthy-threshold-count 2 \
    --unhealthy-threshold-count 3 \
    --query "TargetGroups[0].TargetGroupArn" --output text --region "$AWS_REGION")
  log_ok "Created Frontend Target Group: $FRONTEND_TG_ARN"
else
  log_ok "Frontend Target Group already exists: $FRONTEND_TG_ARN"
fi

# ═══════════════════════════════════════════════════════════════════════
# Step 8: Create ALB Listener & Routing Rules
# ═══════════════════════════════════════════════════════════════════════
log_step "8" "Creating ALB Listener & Routing Rules"

LISTENER_ARN=$(aws elbv2 describe-listeners --load-balancer-arn "$ALB_ARN" \
  --query "Listeners[?Port==\`80\`].ListenerArn" --output text --region "$AWS_REGION" 2>/dev/null || echo "")

if [ -z "$LISTENER_ARN" ] || [ "$LISTENER_ARN" == "None" ]; then
  LISTENER_ARN=$(aws elbv2 create-listener \
    --load-balancer-arn "$ALB_ARN" \
    --protocol HTTP \
    --port 80 \
    --default-actions "Type=forward,TargetGroupArn=$FRONTEND_TG_ARN" \
    --query "Listeners[0].ListenerArn" --output text --region "$AWS_REGION")
  log_ok "Created HTTP Listener: $LISTENER_ARN"
else
  log_ok "HTTP Listener already exists: $LISTENER_ARN"
fi

# Path-based routing: /api/* → backend
EXISTING_RULES=$(aws elbv2 describe-rules --listener-arn "$LISTENER_ARN" \
  --query "Rules[?Priority!='default'].Priority" --output text --region "$AWS_REGION" 2>/dev/null || echo "")

if [ -z "$EXISTING_RULES" ] || [ "$EXISTING_RULES" == "None" ]; then
  aws elbv2 create-rule \
    --listener-arn "$LISTENER_ARN" \
    --priority 10 \
    --conditions '[{"Field":"path-pattern","PathPatternConfig":{"Values":["/api/*"]}}]' \
    --actions "[{\"Type\":\"forward\",\"TargetGroupArn\":\"$BACKEND_TG_ARN\"}]" \
    --region "$AWS_REGION"
  log_ok "Created path-based routing rule: /api/* → backend"
else
  log_ok "Routing rules already exist"
fi

# ═══════════════════════════════════════════════════════════════════════
# Step 9: Create IAM Role for ECS Tasks (if not exists)
# ═══════════════════════════════════════════════════════════════════════
log_step "9" "Checking ECS Task Execution Role"

if aws iam get-role --role-name ecsTaskExecutionRole 2>/dev/null; then
  log_ok "ecsTaskExecutionRole already exists"
else
  log_info "Creating ecsTaskExecutionRole..."
  aws iam create-role \
    --role-name ecsTaskExecutionRole \
    --assume-role-policy-document '{
      "Version": "2012-10-17",
      "Statement": [{
        "Effect": "Allow",
        "Principal": {"Service": "ecs-tasks.amazonaws.com"},
        "Action": "sts:AssumeRole"
      }]
    }'
  aws iam attach-role-policy \
    --role-name ecsTaskExecutionRole \
    --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy
  log_ok "Created and configured ecsTaskExecutionRole"
fi

# ═══════════════════════════════════════════════════════════════════════
# Step 10: Register Task Definitions
# ═══════════════════════════════════════════════════════════════════════
log_step "10" "Registering Task Definitions"

# Update task definitions with actual values
BACKEND_TD=$(cat ecs/backend-task-definition.json \
  | sed "s/ACCOUNT_ID/$ACCOUNT_ID/g" \
  | sed "s/REGION/$AWS_REGION/g")

FRONTEND_TD=$(cat ecs/frontend-task-definition.json \
  | sed "s/ACCOUNT_ID/$ACCOUNT_ID/g" \
  | sed "s/REGION/$AWS_REGION/g")

echo "$BACKEND_TD" > backend-task.tmp.json
aws ecs register-task-definition --cli-input-json file://backend-task.tmp.json --region "$AWS_REGION"
rm -f backend-task.tmp.json
log_ok "Registered backend task definition"

echo "$FRONTEND_TD" > frontend-task.tmp.json
aws ecs register-task-definition --cli-input-json file://frontend-task.tmp.json --region "$AWS_REGION"
rm -f frontend-task.tmp.json
log_ok "Registered frontend task definition"

# ═══════════════════════════════════════════════════════════════════════
# Step 11: Create ECS Services
# ═══════════════════════════════════════════════════════════════════════
log_step "11" "Creating ECS Services"

# Format subnet list for awsvpcConfiguration
SUBNET_LIST=$(IFS=','; echo "${SUBNET_ARRAY[*]}")

# Backend Service
BACKEND_SVC=$(aws ecs describe-services --cluster "$CLUSTER_NAME" \
  --services test-backend-service --query "services[?status=='ACTIVE'].serviceName" \
  --output text --region "$AWS_REGION" 2>/dev/null || echo "")

if [ -z "$BACKEND_SVC" ] || [ "$BACKEND_SVC" == "None" ]; then
  aws ecs create-service \
    --cluster "$CLUSTER_NAME" \
    --service-name test-backend-service \
    --task-definition test-backend \
    --desired-count "$DESIRED_COUNT" \
    --launch-type FARGATE \
    --health-check-grace-period-seconds 90 \
    --network-configuration "awsvpcConfiguration={subnets=[$SUBNET_LIST],securityGroups=[$ECS_SG_ID],assignPublicIp=ENABLED}" \
    --load-balancers "targetGroupArn=$BACKEND_TG_ARN,containerName=backend,containerPort=3000" \
    --region "$AWS_REGION"
  log_ok "Created backend service with $DESIRED_COUNT tasks"
else
  aws ecs update-service \
    --cluster "$CLUSTER_NAME" \
    --service test-backend-service \
    --task-definition test-backend \
    --desired-count "$DESIRED_COUNT" \
    --force-new-deployment \
    --region "$AWS_REGION"
  log_ok "Updated backend service"
fi

# Frontend Service
FRONTEND_SVC=$(aws ecs describe-services --cluster "$CLUSTER_NAME" \
  --services test-frontend-service --query "services[?status=='ACTIVE'].serviceName" \
  --output text --region "$AWS_REGION" 2>/dev/null || echo "")

if [ -z "$FRONTEND_SVC" ] || [ "$FRONTEND_SVC" == "None" ]; then
  aws ecs create-service \
    --cluster "$CLUSTER_NAME" \
    --service-name test-frontend-service \
    --task-definition test-frontend \
    --desired-count "$DESIRED_COUNT" \
    --launch-type FARGATE \
    --health-check-grace-period-seconds 30 \
    --network-configuration "awsvpcConfiguration={subnets=[$SUBNET_LIST],securityGroups=[$ECS_SG_ID],assignPublicIp=ENABLED}" \
    --load-balancers "targetGroupArn=$FRONTEND_TG_ARN,containerName=frontend,containerPort=80" \
    --region "$AWS_REGION"
  log_ok "Created frontend service with $DESIRED_COUNT tasks"
else
  aws ecs update-service \
    --cluster "$CLUSTER_NAME" \
    --service test-frontend-service \
    --task-definition test-frontend \
    --desired-count "$DESIRED_COUNT" \
    --force-new-deployment \
    --region "$AWS_REGION"
  log_ok "Updated frontend service"
fi

# ═══════════════════════════════════════════════════════════════════════
# Done!
# ═══════════════════════════════════════════════════════════════════════
echo ""
echo -e "${GREEN}═══════════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  🎉 Deployment Complete!${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════════════════${NC}"
echo ""
echo -e "  ${CYAN}ALB DNS:${NC}    http://${ALB_DNS}"
echo -e "  ${CYAN}Frontend:${NC}   http://${ALB_DNS}/"
echo -e "  ${CYAN}Backend:${NC}    http://${ALB_DNS}/api/health"
echo -e "  ${CYAN}LB Test:${NC}    http://${ALB_DNS}/api/lb-test"
echo -e "  ${CYAN}Error Test:${NC} http://${ALB_DNS}/api/error-test?type=crash"
echo ""
echo -e "  ${CYAN}SigNoz:${NC}     ${SIGNOZ_ENDPOINT}"
echo -e "  ${CYAN}Service:${NC}    test"
echo ""
echo -e "  ${YELLOW}Logs will appear in SigNoz under service name 'test'${NC}"
echo -e "  ${YELLOW}It may take 2-5 minutes for tasks to become healthy.${NC}"
echo ""
