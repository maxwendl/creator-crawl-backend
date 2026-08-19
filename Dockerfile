FROM node:18-slim

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy application code
COPY server.js .

# Cloud Run sets the PORT environment variable
EXPOSE 8080

# Start server
CMD ["npm", "start"]
