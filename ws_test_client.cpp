// ============================================================
// ws_test_client.cpp — WebSocket 测试客户端
// 连接 Relay 服务器，以 pub 身份发送航天基地假数据
// 编译: cl /EHsc /O2 ws_test_client.cpp /link ws2_32.lib /out:ws_test_client.exe
// 或 MinGW: g++ -O2 -o ws_test_client.exe ws_test_client.cpp -lws2_32
// ============================================================

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#pragma comment(lib, "ws2_32.lib")

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <ctime>
#include <cmath>
#include <string>
#include <vector>
#include <cstdint>

// ─────────────────────────────────────────────
// Base64 编码
// ─────────────────────────────────────────────
static std::string B64Enc(const uint8_t* data, size_t len) {
    static const char* T = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string out;
    for (size_t i = 0; i < len; i += 3) {
        uint32_t v = (data[i] << 16) | ((i + 1 < len ? data[i + 1] : 0) << 8) | (i + 2 < len ? data[i + 2] : 0);
        out += T[(v >> 18) & 0x3F];
        out += T[(v >> 12) & 0x3F];
        out += (i + 1 < len) ? T[(v >> 6) & 0x3F] : '=';
        out += (i + 2 < len) ? T[v & 0x3F] : '=';
    }
    return out;
}

// ─────────────────────────────────────────────
// 生成随机 WebSocket Key
// ─────────────────────────────────────────────
static std::string GenWSKey() {
    uint8_t raw[16];
    srand((unsigned)time(nullptr) ^ GetTickCount());
    for (int i = 0; i < 16; i++) raw[i] = (uint8_t)(rand() & 0xFF);
    return B64Enc(raw, 16);
}

// ─────────────────────────────────────────────
// 发送 WebSocket 帧 (客户端必须 Masking)
// ─────────────────────────────────────────────
static bool SendFrame(SOCKET s, uint8_t opcode, const uint8_t* data, size_t plen) {
    std::vector<uint8_t> frame;
    frame.push_back(0x80 | opcode);

    uint8_t mask[4];
    uint32_t r = (uint32_t)rand() ^ (uint32_t)GetTickCount();
    mask[0] = (uint8_t)(r); mask[1] = (uint8_t)(r >> 8);
    mask[2] = (uint8_t)(r >> 16); mask[3] = (uint8_t)(r >> 24);

    if (plen <= 125) {
        frame.push_back(0x80 | (uint8_t)plen);
    } else if (plen <= 65535) {
        frame.push_back(0x80 | 126);
        frame.push_back((uint8_t)(plen >> 8));
        frame.push_back((uint8_t)(plen & 0xFF));
    } else {
        frame.push_back(0x80 | 127);
        for (int i = 7; i >= 0; i--) frame.push_back((uint8_t)(plen >> (i * 8)));
    }

    frame.insert(frame.end(), mask, mask + 4);
    size_t offset = frame.size();
    frame.resize(frame.size() + plen);
    for (size_t i = 0; i < plen; i++) frame[offset + i] = data[i] ^ mask[i % 4];

    int total = (int)frame.size(), sent = 0;
    while (sent < total) {
        int r2 = ::send(s, (char*)frame.data() + sent, total - sent, 0);
        if (r2 <= 0) return false;
        sent += r2;
    }
    return true;
}

static bool SendText(SOCKET s, const std::string& text) {
    return SendFrame(s, 0x01, (const uint8_t*)text.data(), text.size());
}

// ─────────────────────────────────────────────
// TCP 连接
// ─────────────────────────────────────────────
static SOCKET ConnectTCP(const char* host, int port) {
    struct addrinfo hints = {}, * res = nullptr;
    hints.ai_family = AF_INET;
    hints.ai_socktype = SOCK_STREAM;
    char portStr[16];
    snprintf(portStr, sizeof(portStr), "%d", port);

    if (getaddrinfo(host, portStr, &hints, &res) != 0 || !res) return INVALID_SOCKET;

    SOCKET s = socket(res->ai_family, res->ai_socktype, res->ai_protocol);
    if (s == INVALID_SOCKET) { freeaddrinfo(res); return INVALID_SOCKET; }

    int opt = 1;
    setsockopt(s, IPPROTO_TCP, TCP_NODELAY, (char*)&opt, sizeof(opt));

    if (connect(s, res->ai_addr, (int)res->ai_addrlen) != 0) {
        closesocket(s);
        freeaddrinfo(res);
        return INVALID_SOCKET;
    }
    freeaddrinfo(res);
    return s;
}

// ─────────────────────────────────────────────
// WebSocket 握手
// ─────────────────────────────────────────────
static bool DoHandshake(SOCKET s, const char* host, int port) {
    std::string wsKey = GenWSKey();
    char req[512];
    snprintf(req, sizeof(req),
        "GET / HTTP/1.1\r\n"
        "Host: %s:%d\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        "Sec-WebSocket-Version: 13\r\n"
        "Sec-WebSocket-Key: %s\r\n"
        "Origin: http://%s\r\n"
        "\r\n",
        host, port, wsKey.c_str(), host);

    if (::send(s, req, (int)strlen(req), 0) <= 0) return false;

    char buf[2048] = {};
    int n = recv(s, buf, sizeof(buf) - 1, 0);
    if (n <= 0) return false;
    if (!strstr(buf, "101")) return false;
    return true;
}

// ─────────────────────────────────────────────
// 随机浮点
// ─────────────────────────────────────────────
static float RandF(float lo, float hi) {
    return lo + (float)rand() / (float)RAND_MAX * (hi - lo);
}

// ─────────────────────────────────────────────
// 主函数
// ─────────────────────────────────────────────
int main() {
    // Windows 控制台 UTF-8
    SetConsoleOutputCP(65001);

    char host[128] = "127.0.0.1";
    int port = 5000;
    char roomKey[64] = "repro";

    printf("========================================\n");
    printf("  WebSocket 雷达测试客户端\n");
    printf("========================================\n\n");
    printf("服务器地址 [%s]: ", host);
    {
        char tmp[128];
        if (fgets(tmp, sizeof(tmp), stdin) && tmp[0] != '\n' && tmp[0] != '\r') {
            tmp[strcspn(tmp, "\r\n")] = 0;
            strncpy_s(host, tmp, _TRUNCATE);
        }
    }
    printf("端口 [%d]: ", port);
    {
        char tmp[16];
        if (fgets(tmp, sizeof(tmp), stdin) && tmp[0] != '\n' && tmp[0] != '\r') {
            int p = atoi(tmp);
            if (p > 0 && p < 65536) port = p;
        }
    }
    printf("房间号 [%s]: ", roomKey);
    {
        char tmp[64];
        if (fgets(tmp, sizeof(tmp), stdin) && tmp[0] != '\n' && tmp[0] != '\r') {
            tmp[strcspn(tmp, "\r\n")] = 0;
            strncpy_s(roomKey, tmp, _TRUNCATE);
        }
    }

    printf("\n>> 连接 %s:%d 房间=%s\n", host, port, roomKey);

    WSADATA wsa;
    WSAStartup(MAKEWORD(2, 2), &wsa);
    srand((unsigned)time(nullptr));

    // 连接
    SOCKET sock = ConnectTCP(host, port);
    if (sock == INVALID_SOCKET) {
        printf("[错误] TCP 连接失败!\n");
        printf("按回车退出..."); getchar();
        return 1;
    }
    printf("[OK] TCP 已连接\n");

    // 握手
    if (!DoHandshake(sock, host, port)) {
        printf("[错误] WebSocket 握手失败!\n");
        closesocket(sock);
        printf("按回车退出..."); getchar();
        return 1;
    }
    printf("[OK] WebSocket 握手成功\n");

    // 认证
    char authMsg[256];
    snprintf(authMsg, sizeof(authMsg), "{\"action\":\"auth\",\"role\":\"pub\",\"key\":\"%s\"}", roomKey);
    if (!SendText(sock, authMsg)) {
        printf("[错误] 发送认证消息失败!\n");
        closesocket(sock);
        printf("按回车退出..."); getchar();
        return 1;
    }

    // 读认证响应
    char resp[512] = {};
    int rn = recv(sock, resp, sizeof(resp) - 1, 0);
    if (rn > 2) {
        // 解析 WS 帧 payload
        uint8_t len = resp[1] & 0x7F;
        int off = 2;
        if (len == 126) off = 4;
        else if (len == 127) off = 10;
        if (off < rn) {
            std::string payload(resp + off, rn - off);
            printf("[认证响应] %s\n", payload.c_str());
            if (payload.find("\"ok\":true") == std::string::npos) {
                printf("[错误] 认证失败!\n");
                closesocket(sock);
                printf("按回车退出..."); getchar();
                return 1;
            }
        }
    }
    printf("[OK] 认证成功! 开始发送数据...\n\n");

    // ── 发送地图名：航天基地 ──
    std::string mapMsg = "{\"type\":\"mapName\",\"data\":\"SpaceCenter_Level_Main\"}";
    SendText(sock, mapMsg);
    printf("[发送] mapName = SpaceCenter_Level_Main (航天基地)\n");
    Sleep(200);

    // ── 航天基地大致坐标范围 ──
    // 中心大约: X=50000, Y=-50000, Z=5000 (UE坐标，厘米)
    float selfX = 45000.0f, selfY = -48000.0f, selfZ = 5200.0f;
    float selfYaw = 0.0f;
    int frame = 0;

    printf("\n[运行中] 每 100ms 发送一帧数据，按 Ctrl+C 退出\n");
    printf("─────────────────────────────────────────\n");

    while (true) {
        frame++;
        // 自身缓慢移动
        selfX += RandF(-50.0f, 50.0f);
        selfY += RandF(-50.0f, 50.0f);
        selfZ += RandF(-5.0f, 5.0f);
        selfYaw += RandF(-5.0f, 5.0f);
        if (selfYaw > 360.0f) selfYaw -= 360.0f;
        if (selfYaw < 0.0f) selfYaw += 360.0f;

        // ── self ──
        char buf[1024];
        snprintf(buf, sizeof(buf),
            "{\"type\":\"self\",\"data\":{\"x\":%.1f,\"y\":%.1f,\"z\":%.1f,"
            "\"yw\":%.1f,\"map\":\"SpaceCenter_Level_Main\",\"n\":\"TestPlayer\"}}",
            selfX, selfY, selfZ, selfYaw);
        SendText(sock, std::string(buf));

        // ── players (3个敌人 + 2个AI + 1个队友) ──
        std::string pj = "{\"type\":\"players\",\"data\":[";
        // 敌方玩家
        for (int i = 0; i < 3; i++) {
            float px = selfX + RandF(-8000.0f, 8000.0f);
            float py = selfY + RandF(-8000.0f, 8000.0f);
            float pz = selfZ + RandF(-500.0f, 500.0f);
            float yw = RandF(0, 360);
            int hp = 60 + rand() % 41;
            int tid = 2 + i; // 不同队伍
            const char* names[] = { "EnemyAlpha", "EnemyBravo", "EnemyCharlie" };
            snprintf(buf, sizeof(buf),
                "%s{\"x\":%.1f,\"y\":%.1f,\"z\":%.1f,\"h\":%d,\"mh\":100,"
                "\"t\":%d,\"ai\":0,\"tm\":0,\"dn\":0,\"n\":\"%s\","
                "\"hr\":25,\"w\":18010000001,\"hl\":%d,\"ar\":%d,"
                "\"hh\":50,\"hm\":50,\"ah\":60,\"am\":60,\"yw\":%.1f}",
                i > 0 ? "," : "",
                px, py, pz, hp, tid, names[i],
                1 + rand() % 5, 1 + rand() % 5, yw);
            pj += buf;
        }
        // AI
        for (int i = 0; i < 2; i++) {
            float px = selfX + RandF(-10000.0f, 10000.0f);
            float py = selfY + RandF(-10000.0f, 10000.0f);
            float pz = selfZ + RandF(-300.0f, 300.0f);
            const char* aiNames[] = { "AI_Guard_01", "AI_Patrol_02" };
            snprintf(buf, sizeof(buf),
                ",{\"x\":%.1f,\"y\":%.1f,\"z\":%.1f,\"h\":%d,\"mh\":100,"
                "\"ai\":1,\"n\":\"%s\"}",
                px, py, pz, 50 + rand() % 51, aiNames[i]);
            pj += buf;
        }
        // 队友
        {
            float px = selfX + RandF(-2000.0f, 2000.0f);
            float py = selfY + RandF(-2000.0f, 2000.0f);
            float pz = selfZ + RandF(-200.0f, 200.0f);
            snprintf(buf, sizeof(buf),
                ",{\"x\":%.1f,\"y\":%.1f,\"z\":%.1f,\"h\":100,\"mh\":100,"
                "\"t\":1,\"ai\":0,\"tm\":1,\"dn\":0,\"n\":\"Teammate_01\","
                "\"hr\":30,\"w\":18020000002,\"hl\":4,\"ar\":4,"
                "\"hh\":50,\"hm\":50,\"ah\":60,\"am\":60,\"yw\":%.1f}",
                px, py, pz, RandF(0, 360));
            pj += buf;
        }
        pj += "]}";
        SendText(sock, pj);

        // ── 每 15 帧(1.5s) 发一次静态实体 ──
        if (frame % 15 == 1) {
            // items (5个随机物品)
            std::string ij = "{\"type\":\"items\",\"data\":[";
            const char* itemNames[] = {
                "5.56x45mm AP", "AKM", "Lv3 Helmet", "IFAK MedKit", "Holoscope"
            };
            const char* itemOids[] = {
                "gun/ammo/5.56x45mm", "", "", "", ""
            };
            int itemVals[] = { 3000, 45000, 28000, 8000, 55000 };
            int itemQs[] = { 2, 4, 3, 2, 5 };
            for (int i = 0; i < 5; i++) {
                float ix = selfX + RandF(-15000.0f, 15000.0f);
                float iy = selfY + RandF(-15000.0f, 15000.0f);
                float iz = selfZ + RandF(-500.0f, 500.0f);
                snprintf(buf, sizeof(buf),
                    "%s{\"x\":%.1f,\"y\":%.1f,\"z\":%.1f,\"n\":\"%s\",\"oid\":\"%s\",\"v\":%d,\"q\":%d}",
                    i > 0 ? "," : "",
                    ix, iy, iz, itemNames[i], itemOids[i], itemVals[i], itemQs[i]);
                ij += buf;
            }
            ij += "]}";
            SendText(sock, ij);

            // containers (2个保险箱)
            std::string cj = "{\"type\":\"containers\",\"data\":[";
            for (int i = 0; i < 2; i++) {
                float cx = selfX + RandF(-12000.0f, 12000.0f);
                float cy = selfY + RandF(-12000.0f, 12000.0f);
                float cz = selfZ + RandF(-300.0f, 300.0f);
                snprintf(buf, sizeof(buf),
                    "%s{\"x\":%.1f,\"y\":%.1f,\"z\":%.1f,\"t\":%d,\"o\":0}",
                    i > 0 ? "," : "", cx, cy, cz, i == 0 ? 1 : 2);
                cj += buf;
            }
            cj += "]}";
            SendText(sock, cj);

            // exits (2个撤离点)
            std::string ej = "{\"type\":\"exits\",\"data\":[";
            float ex1x = selfX + 20000.0f, ex1y = selfY - 15000.0f;
            float ex2x = selfX - 18000.0f, ex2y = selfY + 12000.0f;
            snprintf(buf, sizeof(buf),
                "{\"x\":%.1f,\"y\":%.1f,\"z\":%.1f,\"s\":0},"
                "{\"x\":%.1f,\"y\":%.1f,\"z\":%.1f,\"s\":1}",
                ex1x, ex1y, selfZ, ex2x, ex2y, selfZ);
            ej += buf;
            ej += "]}";
            SendText(sock, ej);

            // boxes (1个死亡盒)
            snprintf(buf, sizeof(buf),
                "{\"type\":\"boxes\",\"data\":["
                "{\"x\":%.1f,\"y\":%.1f,\"z\":%.1f,\"p\":1,\"ai\":0,\"bt\":1,\"n\":\"DeadGuy\"}"
                "]}",
                selfX + RandF(-5000, 5000), selfY + RandF(-5000, 5000), selfZ);
            SendText(sock, std::string(buf));

            printf("[帧 %d] 已发送静态实体 (items=%d, containers=%d, exits=%d, boxes=%d)\n",
                frame, 5, 2, 2, 1);
        }

        if (frame % 10 == 0) {
            printf("[帧 %d] self=(%.0f, %.0f, %.0f) yaw=%.0f | 玩家=6(3敌+2AI+1友)\n",
                frame, selfX, selfY, selfZ, selfYaw);
        }

        Sleep(100); // 100ms = 10Hz
    }

    closesocket(sock);
    WSACleanup();
    return 0;
}
