FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
CMD ["node", "src/index.ts"]
