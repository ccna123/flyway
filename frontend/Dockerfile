# Stage 1: Build React app
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
# VITE_API_KEY can be injected at build time if needed
ARG VITE_API_KEY="FPkmJsd4U8kkVUbxMSrMgh4brBh0R8xoWTUg7vuGK6CstqdlZAUa8bN7ku9K7QvR"
ENV VITE_API_KEY=$VITE_API_KEY
RUN npm run build

# Stage 2: Serve with nginx
FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
