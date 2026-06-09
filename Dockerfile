FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV PORT=7860
EXPOSE 7860
CMD ["node", "server/index.js"]
