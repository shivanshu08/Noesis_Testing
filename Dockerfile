FROM maven:3.9-eclipse-temurin-17 AS build

WORKDIR /app

COPY backend/pom.xml backend/pom.xml
RUN cd backend && mvn -DskipTests dependency:go-offline

COPY backend backend
RUN cd backend && mvn -DskipTests package

FROM eclipse-temurin:17-jre

WORKDIR /app

COPY --from=build /app/backend/target/noesis-testing-backend-1.0.0.jar backend/target/noesis-testing-backend-1.0.0.jar
COPY database database

EXPOSE 10000

CMD ["java", "-jar", "backend/target/noesis-testing-backend-1.0.0.jar"]
