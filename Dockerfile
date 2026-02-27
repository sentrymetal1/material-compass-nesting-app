FROM node:18-alpine

WORKDIR /app

# Install server dependencies
COPY package.json ./
RUN npm install --production

# Install client dependencies and build
COPY client/package.json client/
RUN cd client && npm install

COPY client/ client/
RUN cd client && npm run build

# Copy server
COPY server/ server/

EXPOSE 3000

CMD ["node", "server/index.js"]
