# EC2 Deployment: systemd and Nginx

This document records how the Node.js Express application was configured to run reliably on an Amazon Linux 2023 EC2 instance.

## 1: Connect to Instance 

```
ssh -i "C:\Users\ashis\Downloads\aws-ec2-node-key.pem" ec2-user@YOUR_PUBLIC_IP
```

```
$env:BASE_URL = "http://13.232.36.183"

node .\scripts\event-loop-benchmark.js
```

## 2. Why We Created a systemd Service 

Running the application manually with `node server.js` is suitable for local development, but it is not a reliable way to run an application on a server. If the SSH session ends or the process crashes, the application may stop running.

We created a **systemd service** so Linux can manage the Node.js process independently of the SSH session. The service starts automatically when the instance boots, restarts the application after unexpected failures, and provides commands to inspect its status and logs.

## 3. Create the systemd Service

### Step 1: Prepare the application directory

The deployed application is stored separately from the Git clone:

```bash
sudo mkdir -p /opt/aws-ec2-app
```

A dedicated Linux service account named `awsapp` runs the application instead of running it as `root`.

The deployment directory contains:

- `server.js`
- `package.json`
- `package-lock.json`
- `.env`
- Production dependencies in `node_modules`

The application files are owned by the service account:

```bash
sudo chown -R awsapp:awsapp /opt/aws-ec2-app
sudo chmod 600 /opt/aws-ec2-app/.env
```

### Step 2: Create the service file

Create the systemd service definition:

```bash
sudo nano /etc/systemd/system/aws-ec2-app.service
```

Add the following configuration:

```ini
[Unit]
Description=AWS EC2 Node.js Express Application
After=network.target

[Service]
Type=simple
User=awsapp
Group=awsapp
WorkingDirectory=/opt/aws-ec2-app
EnvironmentFile=/opt/aws-ec2-app/.env
ExecStart=/usr/bin/node-24 /opt/aws-ec2-app/server.js
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true

[Install]
WantedBy=multi-user.target
```

Save the file and exit the editor.

### What the important settings mean

| Setting | Purpose |
|---|---|
| `User` and `Group` | Run the application as the dedicated `awsapp` account. |
| `WorkingDirectory` | Set the application directory. |
| `EnvironmentFile` | Load environment variables from `.env`. |
| `ExecStart` | Specify the Node.js executable and application entry point. |
| `Restart=on-failure` | Restart the process if it exits unexpectedly with a failure. |
| `RestartSec=5` | Wait five seconds before attempting a restart. |
| `NoNewPrivileges=true` | Prevent the process from gaining additional privileges. |
| `PrivateTmp=true` | Give the service a private temporary directory. |
| `ProtectSystem=strict` | Make most of the filesystem read-only to the service. |
| `ProtectHome=true` | Restrict access to home directories. |
| `WantedBy=multi-user.target` | Allow the service to be enabled for normal system startup. |

The service uses Node.js 24 through `/usr/bin/node-24`, matching the runtime installed on the instance.

## 3. Start and Verify the Service

### Step 1: Reload systemd

Whenever a service file is created or changed, reload systemd so it recognizes the configuration:

```bash
sudo systemctl daemon-reload
```

### Step 2: Enable and start the service

```bash
sudo systemctl enable --now aws-ec2-app
```

- `enable` configures the service to start automatically at boot.
- `--now` starts the service immediately.

### Step 3: Check the service status

```bash
sudo systemctl status aws-ec2-app --no-pager
```

Look for:

```text
Active: active (running)
```

### Step 4: Test Express locally on EC2

```bash
curl -i http://127.0.0.1:3000/health
```

A successful response should return HTTP `200 OK` and the health-check JSON.

You can also test the root endpoint:

```bash
curl -i http://127.0.0.1:3000/
```

These tests bypass Nginx and check Express directly.

### Step 5: Inspect application logs

View recent service logs:

```bash
sudo journalctl -u aws-ec2-app -n 50 --no-pager
```

Follow new log entries in real time:

```bash
sudo journalctl -u aws-ec2-app -f
```

### Step 6: Restart or stop the service

Restart after deploying updated application code:

```bash
sudo systemctl restart aws-ec2-app
```

Stop the application:

```bash
sudo systemctl stop aws-ec2-app
```

Start it again:

```bash
sudo systemctl start aws-ec2-app
```

Check whether it is enabled at boot:

```bash
sudo systemctl is-enabled aws-ec2-app
```

Expected output:

```text
enabled
```

## 4. Why We Installed Nginx

Express listens on `127.0.0.1:3000`, so the application port does not need to be exposed directly to the internet. We installed **Nginx as a reverse proxy** to accept HTTP requests on port 80 and forward them to the Express application. This separates the public-facing web server from the application process and gives us a convenient place to configure request routing and access restrictions.

Nginx also lets us keep the EC2 security group simple: allow public HTTP traffic on port 80, restrict SSH port 22 to the developer's current public IP, and leave port 3000 closed to public inbound traffic. For a production deployment, HTTPS should also be configured.

## 5. Install and Configure Nginx

### Step 1: Install Nginx

On Amazon Linux 2023:

```bash
sudo dnf install -y nginx
```

Verify the installation:

```bash
nginx -v
```

### Step 2: Enable and start Nginx

```bash
sudo systemctl enable --now nginx
```

Check the service:

```bash
sudo systemctl status nginx --no-pager
```

### Step 3: Create the reverse-proxy configuration

Create a configuration file for the Express application:

```bash
sudo nano /etc/nginx/conf.d/aws-ec2-app.conf
```

Add the following configuration:

```nginx
server {
    listen 80;
    server_name _;

    # Forward other requests to Express.
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

**Important:** Both `location` blocks must be inside the `server` block. A `location` directive placed at the top level of this file causes Nginx configuration validation to fail.

The exact-match location for `/debug/cpu-blocking` returns HTTP `404` to public requests. The benchmark can access this endpoint through a controlled connection, such as an SSH tunnel, without exposing the CPU-intensive route publicly.

### Step 4: Validate the configuration

Always test the configuration before restarting Nginx:

```bash
sudo nginx -t
```

Proceed only if the output confirms that the syntax is valid and the test is successful.

### Step 5: Reload or restart Nginx

After a successful configuration test:

```bash
sudo systemctl restart nginx
```

Verify that Nginx is running:

```bash
sudo systemctl status nginx --no-pager
```

### Step 6: Test the reverse proxy

Test the health endpoint through Nginx on the EC2 instance:

```bash
curl -i "http://127.0.0.1/debug/cpu-blocking?durationMs=500"

curl -i "http://127.0.0.1/health"
```

This request goes to port 80, passes through Nginx, and is forwarded to Express on port 3000.

The public health endpoint can also be tested from your computer:

```text
Invoke-RestMethod "http://YOUR_CURRENT_EC2_PUBLIC_IP/debug/cpu-blocking?durationMs=500"
```

Replace the placeholder with the instance's current public IPv4 address.

## 6. Request Flow

```text
Client / Postman
       |
       | HTTP :80
       v
     Nginx
       |
       | Proxy to 127.0.0.1:3000
       v
  Express / Node.js
       |
       v
  systemd-managed process
```

The CPU-debug route is an exception to normal proxying because Nginx blocks public access to that path.

## 7. Deployment Verification Checklist

- [ ] `aws-ec2-app` is active and running.
- [ ] The application is enabled to start at boot.
- [ ] Express responds successfully on `127.0.0.1:3000/health`.
- [ ] Nginx is active and enabled.
- [ ] `sudo nginx -t` succeeds.
- [ ] `http://127.0.0.1/health` responds successfully through Nginx.
- [ ] Port 3000 is not exposed publicly in the EC2 security group.
- [ ] SSH port 22 is restricted to the current trusted IP.
- [ ] The CPU-debug endpoint is not publicly accessible.


# Performance Benchmarking

This project uses Autocannon to benchmark HTTP performance and compare CPU-intensive operations executed on the Node.js main thread versus Worker Threads.

### 1. Install Autocannon

Autocannon is installed as a development dependency:

```powershell
npm install --save-dev autocannon
```

### 2. Baseline HTTP Benchmark

Run a baseline benchmark against the health endpoint without an additional CPU-intensive workload:

```powershell
npx autocannon -c 10 -d 30 -p 1 "http://<EC2_PUBLIC_IP>/health"
```

Options:

- `-c 10`: Use 10 concurrent connections.
- `-d 30`: Run the benchmark for 30 seconds.
- `-p 1`: Use one request per connection at a time.

### 3. Controlled Performance Benchmark

The project includes a controlled benchmark script:

```text
scripts/
└── controlled-benchmark.js
```

The script runs two workloads concurrently:

1. Autocannon sends HTTP requests to `/health`.
2. The script continuously sends CPU-intensive requests to either the blocking or Worker Thread endpoint.

Benchmark configuration:

- 10 concurrent HTTP connections.
- 60-second Autocannon duration.
- 50,000,000 calculation iterations per CPU request.
- CPU workload starts approximately one second after Autocannon starts.

#### Test main-thread blocking

```powershell
node .\scripts\controlled-benchmark.js "http://<EC2_PUBLIC_IP>" blocking
```

This executes the CPU-intensive calculation on the Node.js main thread.

#### Test Worker Threads

```powershell
node .\scripts\controlled-benchmark.js "http://<EC2_PUBLIC_IP>" worker
```

This executes the same calculation inside a Worker Thread.

Run the two experiments separately to avoid overlapping workloads.

### 4. EC2 CPU and Memory Monitoring

Connect to the EC2 instance through SSH before running the monitoring commands.

#### Identify the Node.js process

```bash
PID=$(sudo systemctl show -p MainPID --value aws-ec2-app)
```

Verify the process:

```bash
ps -p "$PID" -o pid,ppid,cmd
```

#### Monitor Node.js process CPU and memory

```bash
top -p "$PID"
```

#### Monitor individual Node.js threads

```bash
top -H -p "$PID"
```

This is useful for observing individual threads when Worker Threads are executing CPU-intensive calculations.

#### Check overall EC2 memory

```bash
free -h
```

#### Monitor overall system CPU and memory activity

```bash
vmstat 1
```

Press `q` to exit `top` and `Ctrl + C` to stop `vmstat`.

### 5. Metrics to Compare

The following metrics are collected during performance testing:

| Metric | Description |
|---|---|
| Requests/sec | Number of HTTP requests handled per second |
| P50 latency | Median response time |
| P97.5 latency | Response-time threshold for 97.5% of requests |
| P99 latency | Response-time threshold for 99% of requests |
| CPU usage | CPU utilization of the Node.js process |
| Memory usage | Resident memory (RES) used by the Node.js process |


### 6. Important Notes

- Run benchmarks from your local machine, not on the EC2 instance being measured, to avoid competing with the application for CPU resources.
- Replace `<EC2_PUBLIC_IP>` with the instance's current public IPv4 address.
- Run blocking and Worker Thread experiments separately using identical benchmark configurations.
- CPU and memory readings from `top` are observations at a particular point in time. For more rigorous comparisons, collect repeated samples throughout each benchmark.
- Worker Threads improve main-thread responsiveness but introduce additional CPU and memory overhead.