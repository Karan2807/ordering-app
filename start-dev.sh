#!/bin/bash

# OrderManager Full-Stack Development Start Script

echo ""
echo "========================================"
echo " OrderManager - Full Stack Setup"
echo "========================================"
echo ""

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "ERROR: Node.js not found. Please install Node.js 18+ from https://nodejs.org/"
    exit 1
fi

echo "✓ Node.js detected:"
node --version

# Check if MongoDB is accessible  
if ! command -v mongo &> /dev/null; then
    echo "WARNING: mongo shell not found. MongoDB might not be installed or not in PATH."
    echo "Please ensure MongoDB is running on localhost:27017"
    echo ""
fi

echo ""
echo "========================================"
echo " Starting Backend..."
echo "========================================"
echo ""

# Start Backend
cd server
npm install
if [ $? -ne 0 ]; then
    echo "ERROR: Failed to install backend dependencies"
    exit 1
fi

npm run dev &
BACKEND_PID=$!
sleep 3

echo ""
echo "========================================"
echo " Starting Frontend..."
echo "========================================"
echo ""

# Navigate to frontend
cd ../ordermanager-deploy/ordermanager-deploy
npm install
if [ $? -ne 0 ]; then
    echo "ERROR: Failed to install frontend dependencies"
    exit 1
fi

npm run dev

# Cleanup on exit
trap "kill $BACKEND_PID 2>/dev/null" EXIT
