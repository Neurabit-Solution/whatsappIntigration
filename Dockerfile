FROM node:20-alpine

WORKDIR /app

COPY . .

RUN npm install --force

RUN npm run build

EXPOSE 3002

CMD ["npm", "run", "preview"]
