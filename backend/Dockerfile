FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    default-jre-headless \
    && rm -rf /var/lib/apt/lists/*

# Install Flyway CLI directly
RUN curl -fL https://download.red-gate.com/maven/release/com/redgate/flyway/flyway-commandline/10.21.0/flyway-commandline-10.21.0-linux-x64.tar.gz \
    | tar -xz -C /opt \
    && ln -s /opt/flyway-10.21.0/flyway /usr/local/bin/flyway

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

RUN mkdir -p /tmp/flyway-sql

EXPOSE 5000

CMD ["gunicorn", "--bind", "0.0.0.0:5000", "--workers", "2", "--timeout", "120", "app:app"]
