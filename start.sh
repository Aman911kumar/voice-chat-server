#!/bin/bash

# Voice Chat Server Startup Script

echo "Starting Voice Chat Server..."

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "Node.js is not installed. Please install Node.js 16 or higher."
    exit 1
fi

# Check if npm is installed
if ! command -v npm &> /dev/null; then
    echo "npm is not installed. Please install npm."
    exit 1
fi

# Install dependencies if node_modules doesn't exist
if [ ! -d "node_modules" ]; then
    echo "Installing dependencies..."
    npm install
fi

# Create recordings directory if it doesn't exist
if [ ! -d "recordings" ]; then
    echo "Creating recordings directory..."
    mkdir -p recordings
fi

# Set environment variables
export NODE_ENV=${NODE_ENV:-development}
export PORT=${PORT:-3001}
export USE_HTTPS=${USE_HTTPS:-false}

echo "Starting server on port $PORT..."
if [ "$USE_HTTPS" = "true" ]; then
    echo "🔒 HTTPS mode enabled"
else
    echo "🔓 HTTP mode"
fi

# Start the server
if [ "$NODE_ENV" = "development" ]; then
    npm run dev
else
    npm start
fi
