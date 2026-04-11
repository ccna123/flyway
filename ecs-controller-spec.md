# ECS Controller — App Spec

React app để admin bật/tắt ECS task chạy FlywayOps, xem trạng thái và lấy URL để truy cập.

---

## Mục đích

Admin không cần vào AWS Console. Chỉ cần mở app này, nhập API key, bấm Start — đợi app FlywayOps khởi động, lấy URL, vào chạy migration, xong bấm Stop.

---

## Architecture

```
React (static, chạy local hoặc S3/CloudFront)
  └── API Gateway (auth bằng x-api-key header)
        └── Lambda
              └── ECS Fargate (FlywayOps app)
```

**3 Lambda endpoints:**

| Method | Path | Mô tả |
|--------|------|--------|
| `POST` | `/start` | Chạy ECS task, `assignPublicIp=ENABLED` |
| `GET` | `/status` | Trả về task status + public IP nếu đang RUNNING |
| `POST` | `/stop` | Dừng ECS task |

Response `/status`:
```json
{
  "status": "STOPPED | STARTING | RUNNING",
  "url": "http://13.xx.xx.xx:5000",   // chỉ có khi RUNNING
  "startedAt": "2026-04-11T10:00:00Z" // chỉ có khi RUNNING
}
```

---

## Chức năng

1. **Nhập và lưu API key** — input lúc đầu, lưu vào localStorage, có thể xóa/thay sau
2. **Xem trạng thái ECS task** — poll mỗi 5s, hiện badge STOPPED / STARTING / RUNNING
3. **Start app** — gọi `/start`, chuyển sang STARTING, poll cho đến khi RUNNING (~30-60s)
4. **Hiện URL** — khi RUNNING hiện link `http://<public-ip>:5000`, bấm vào mở tab mới
5. **Stop app** — gọi `/stop`, confirm trước khi stop
6. **Auto-refresh** — poll liên tục khi đang STARTING để cập nhật trạng thái

---

## UI Layout

```
┌─────────────────────────────────────────┐
│  ⚡ Migration Controller   [API Key ✎] │
├─────────────────────────────────────────┤
│                                         │
│         ● RUNNING                       │
│         Started 4 minutes ago           │
│                                         │
│   🔗 http://13.250.xx.xx:5000  [Open]   │
│                                         │
│         [Stop App]                      │
│                                         │
├─────────────────────────────────────────┤
│  FlywayOps · AWS ECS Fargate            │
└─────────────────────────────────────────┘
```

**Các trạng thái hiển thị:**

| Status | Badge | Nút | Mô tả thêm |
|--------|-------|-----|------------|
| STOPPED | ⚫ STOPPED | [Start App] | |
| STARTING | 🟡 STARTING | [Starting… ] disabled | Spinner, hiện "Waiting for task to be ready..." |
| RUNNING | 🟢 RUNNING | [Stop App] | Hiện URL + thời gian chạy |

---

## UI Component chi tiết

### Header
- Logo/icon: ⚡ hoặc SVG lightning bolt
- App name: `ECS Controller`
- Góc phải: icon bút chì để edit API key, click mở modal nhập lại key

### Status Card (trung tâm màn hình)
- Badge trạng thái: pill lớn, màu theo status
- Subtitle: "Started X minutes ago" khi RUNNING, "Stopped" khi STOPPED, "Initializing…" khi STARTING
- Progress bar hoặc spinner nhỏ khi STARTING

### URL Display (chỉ khi RUNNING)
- Hiện full URL dạng `monospace`
- Nút [Open →] mở tab mới
- Icon copy để copy URL vào clipboard

### Action Button
- Một nút chính ở giữa, thay đổi theo trạng thái
- STOPPED: "Start App" — màu accent (xanh lá)
- STARTING: "Starting…" — disabled, có spinner
- RUNNING: "Stop App" — màu đỏ, có confirm dialog trước khi stop

### Footer
- Text nhỏ: "FlywayOps · AWS ECS Fargate"
- Poll indicator: chấm nhỏ nhấp nháy khi đang poll

### API Key Modal
- Hiện khi chưa có key hoặc khi edit
- Input type password (có toggle show/hide)
- Nút Save lưu vào localStorage
- Validate không để trống

---

## Color Palette

```css
--bg:        #0f1117   /* nền chính, dark */
--surface:   #1a1d27   /* card background */
--border:    #2a2d3a   /* border */
--text1:     #e8eaf0   /* text chính */
--text2:     #9da3b4   /* text phụ */
--text3:     #555b6e   /* placeholder, muted */
--accent:    #3ecf8e   /* xanh lá, màu chính (giống Supabase green) */
--accent-d:  #1a3d2e   /* accent dim background */
--accent-b:  #2a6b4a   /* accent border */
--red:       #f66070   /* stop, error */
--red-d:     #3d1a1f   /* red dim background */
--amber:     #f5a623   /* warning, starting */
--amber-d:   #3d2e0a   /* amber dim background */
--blue:      #5b8ef0   /* link, URL */
--mono:      'JetBrains Mono', 'Fira Code', monospace
```

**Badge colors:**
- STOPPED: text `--text3`, background `--surface`, border `--border`
- STARTING: text `--amber`, background `--amber-d`, border `--amber`
- RUNNING: text `--accent`, background `--accent-d`, border `--accent`

---

## Behavior chi tiết

### Lần đầu mở app (chưa có API key)
1. Hiện modal nhập API key ngay lập tức
2. Không render gì khác cho đến khi có key

### Sau khi có API key
1. Gọi `GET /status` ngay
2. Render trạng thái tương ứng
3. Bắt đầu poll mỗi 5s

### Bấm Start
1. Gọi `POST /start`
2. Chuyển sang STARTING ngay (optimistic UI)
3. Poll mỗi 5s, khi nhận được `status: RUNNING` → hiện URL
4. Nếu sau 5 phút vẫn không RUNNING → hiện lỗi timeout

### Bấm Stop
1. Hiện confirm: "Stop the app? Any unsaved migration progress will be lost."
2. Gọi `POST /stop`
3. Chuyển sang STOPPED ngay (optimistic UI)

### Lỗi API (4xx, 5xx, network error)
- Hiện toast nhỏ ở góc dưới: "Error: {message}" màu đỏ, tự ẩn sau 5s
- Không crash UI, vẫn tiếp tục poll

---

## Tech stack

- **React + Vite** (dùng javascript)
- **Tailwind CSS** 
- Không cần state management library, `useState` + `useEffect` là đủ
- Fetch API thuần, không cần axios
- Không cần router, single page

---

## File structure gợi ý

```
ecs-controller/
├── index.html
├── vite.config.js
├── src/
│   ├── main.jsx
│   ├── App.jsx          # Root, quản lý apiKey state
│   ├── api.js           # Wrapper gọi API Gateway (start/stop/status)
│   ├── components/
│   │   ├── ApiKeyModal.jsx
│   │   ├── StatusCard.jsx
│   │   ├── UrlDisplay.jsx
│   │   └── Toast.jsx
│   └── styles.css       # CSS variables + global styles
└── .env                 # VITE_API_GATEWAY_URL=https://xxx.execute-api.ap-southeast-1.amazonaws.com/prod
```

---

## Environment variable

```bash
# .env
VITE_API_GATEWAY_URL=https://xxxxxxxxxx.execute-api.ap-southeast-1.amazonaws.com/prod
```

API key **không** hardcode vào `.env` — người dùng nhập vào UI, lưu localStorage.
