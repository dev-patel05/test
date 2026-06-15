#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════
# Cleanup Script - Tear down all "test" ECS resources
# ═══════════════════════════════════════════════════════════════════════
set -euo pipefail

AWS_REGION="ap-south-1"
CLUSTER_NAME="test-cluster"
ALB_NAME="test-alb"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${YELLOW}⚠️  This will DELETE all 'test' ECS resources. Press Ctrl+C to cancel.${NC}"
read -p "Are you sure? (yes/no): " CONFIRM
if [ "$CONFIRM" != "yes" ]; then
  echo "Cancelled."
  exit 0
fi

echo -e "\n${RED}Tearing down resources...${NC}\n"

# 1. Delete ECS Services
echo "Deleting ECS services..."
aws ecs update-service --cluster "$CLUSTER_NAME" --service test-backend-service --desired-count 0 --region "$AWS_REGION" 2>/dev/null || true
aws ecs update-service --cluster "$CLUSTER_NAME" --service test-frontend-service --desired-count 0 --region "$AWS_REGION" 2>/dev/null || true
sleep 5
aws ecs delete-service --cluster "$CLUSTER_NAME" --service test-backend-service --force --region "$AWS_REGION" 2>/dev/null || true
aws ecs delete-service --cluster "$CLUSTER_NAME" --service test-frontend-service --force --region "$AWS_REGION" 2>/dev/null || true
echo -e "${GREEN}✓ Services deleted${NC}"

# 2. Delete ALB, Listeners, Target Groups
ALB_ARN=$(aws elbv2 describe-load-balancers --names "$ALB_NAME" \
  --query "LoadBalancers[0].LoadBalancerArn" --output text --region "$AWS_REGION" 2>/dev/null || echo "")

if [ -n "$ALB_ARN" ] && [ "$ALB_ARN" != "None" ]; then
  LISTENERS=$(aws elbv2 describe-listeners --load-balancer-arn "$ALB_ARN" \
    --query "Listeners[].ListenerArn" --output text --region "$AWS_REGION" 2>/dev/null || echo "")
  for L in $LISTENERS; do
    aws elbv2 delete-listener --listener-arn "$L" --region "$AWS_REGION" 2>/dev/null || true
  done
  aws elbv2 delete-load-balancer --load-balancer-arn "$ALB_ARN" --region "$AWS_REGION" 2>/dev/null || true
  echo -e "${GREEN}✓ ALB deleted${NC}"
  echo "Waiting for ALB to be fully deleted..."
  sleep 30
fi

# Delete Target Groups
for TG_NAME in "test-backend-tg" "test-frontend-tg"; do
  TG_ARN=$(aws elbv2 describe-target-groups --names "$TG_NAME" \
    --query "TargetGroups[0].TargetGroupArn" --output text --region "$AWS_REGION" 2>/dev/null || echo "")
  if [ -n "$TG_ARN" ] && [ "$TG_ARN" != "None" ]; then
    aws elbv2 delete-target-group --target-group-arn "$TG_ARN" --region "$AWS_REGION" 2>/dev/null || true
  fi
done
echo -e "${GREEN}✓ Target groups deleted${NC}"

# 3. Delete ECS Cluster
aws ecs delete-cluster --cluster "$CLUSTER_NAME" --region "$AWS_REGION" 2>/dev/null || true
echo -e "${GREEN}✓ Cluster deleted${NC}"

# 4. Delete Security Groups
VPC_ID=$(aws ec2 describe-vpcs --filters "Name=isDefault,Values=true" \
  --query "Vpcs[0].VpcId" --output text --region "$AWS_REGION")

for SG_NAME in "test-alb-sg" "test-ecs-sg"; do
  SG_ID=$(aws ec2 describe-security-groups \
    --filters "Name=group-name,Values=$SG_NAME" "Name=vpc-id,Values=$VPC_ID" \
    --query "SecurityGroups[0].GroupId" --output text --region "$AWS_REGION" 2>/dev/null || echo "")
  if [ -n "$SG_ID" ] && [ "$SG_ID" != "None" ]; then
    aws ec2 delete-security-group --group-id "$SG_ID" --region "$AWS_REGION" 2>/dev/null || true
  fi
done
echo -e "${GREEN}✓ Security groups deleted${NC}"

# 5. Delete ECR Repositories
for REPO in "test-backend" "test-frontend"; do
  aws ecr delete-repository --repository-name "$REPO" --force --region "$AWS_REGION" 2>/dev/null || true
done
echo -e "${GREEN}✓ ECR repositories deleted${NC}"

echo -e "\n${GREEN}═══ Cleanup Complete ═══${NC}"
