/**
 * recorder.js — 房间录制模块
 *
 * 功能:
 *   - 实时记录房间的WebSocket消息流
 *   - 支持开始/暂停/停止录制
 *   - 录制数据保存为JSON文件
 *   - 支持回放列表管理
 *   - 支持分享回放链接
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const log = require('./logger')('Recorder');

// 录制数据存储目录
const RECORDINGS_DIR = path.join(__dirname, '../../recordings');

// 确保录制目录存在
function ensureRecordingsDir() {
  if (!fs.existsSync(RECORDINGS_DIR)) {
    fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
  }
}

// 生成唯一的录制ID
function generateRecordingId() {
  return crypto.randomBytes(8).toString('hex');
}

// 校验 recordingId 只包含 hex 字符, 防 path traversal
function isValidRecordingId(id) {
  return typeof id === 'string' && /^[0-9a-f]{8,32}$/i.test(id);
}

// 录制器类
class RoomRecorder {
  constructor(roomKey, db) {
    this.roomKey = roomKey;
    this.db = db;
    this.recordingId = null;
    this.isRecording = false;
    this.messages = [];
    this.startTime = null;
    this.endTime = null;
    this.metadata = {
      roomKey,
      mapName: '',
      pubIP: '',
      messageCount: 0,
      duration: 0,
      fileSize: 0,
    };
  }

  // 开始录制
  start() {
    if (this.isRecording) {
      log.warn(`Recording already in progress for room ${this.roomKey}`);
      return false;
    }

    this.recordingId = generateRecordingId();
    this.isRecording = true;
    this.messages = [];
    this.startTime = Date.now();
    this.endTime = null;
    
    log.info(`Started recording for room ${this.roomKey}, id: ${this.recordingId}`);
    return true;
  }

  // 暂停录制并保存
  pause() {
    if (!this.isRecording) {
      log.warn(`No recording in progress for room ${this.roomKey}`);
      return null;
    }

    this.isRecording = false;
    this.endTime = Date.now();
    
    // 更新元数据
    this.metadata.messageCount = this.messages.length;
    this.metadata.duration = this.endTime - this.startTime;
    
    // 保存录制数据
    const recording = this.saveRecording();
    
    log.info(`Paused and saved recording ${this.recordingId} for room ${this.roomKey}`);
    return recording;
  }

  // 停止录制：有数据则保存（等同 pause），无数据直接丢弃
  //
  // 历史行为是「停止即丢弃」，但后台只有 pause 会落盘，调用 /api/recording/stop
  // 的客户端会静默丢失整段录制。这里改为：有消息就落盘，空录制才丢弃。
  stop() {
    if (!this.isRecording) return false;

    if (this.messages.length === 0) {
      this.isRecording = false;
      this.messages = [];
      this.recordingId = null;
      this.startTime = null;
      this.endTime = null;
      log.info(`Stopped empty recording for room ${this.roomKey} (discarded)`);
      return true;
    }

    return this.pause();
  }

  // 记录消息
  recordMessage(data, isBinary) {
    if (!this.isRecording) return;
    
    const timestamp = Date.now() - this.startTime;
    
    if (isBinary) {
      // 二进制数据转换为base64
      this.messages.push({
        timestamp,
        type: 'binary',
        data: data.toString('base64'),
      });
    } else {
      // 文本数据
      this.messages.push({
        timestamp,
        type: 'text',
        data: data.toString(),
      });
    }
  }

  // 更新元数据
  updateMetadata(metadata) {
    this.metadata = { ...this.metadata, ...metadata };
  }

  // 保存录制到文件和数据库
  saveRecording() {
    ensureRecordingsDir();
    
    const recordingData = {
      id: this.recordingId,
      metadata: this.metadata,
      messages: this.messages,
      createdAt: this.startTime,
      endedAt: this.endTime,
    };
    
    // 保存到文件
    const filename = `${this.recordingId}.json`;
    const filepath = path.join(RECORDINGS_DIR, filename);
    const jsonStr = JSON.stringify(recordingData);
    fs.writeFileSync(filepath, jsonStr, 'utf8');
    
    this.metadata.fileSize = Buffer.byteLength(jsonStr);
    
    // 保存到数据库
    this.saveToDatabase(recordingData);
    
    return {
      id: this.recordingId,
      filename,
      metadata: this.metadata,
    };
  }

  // 保存到数据库
  saveToDatabase(_recordingData) {
    const p = {
      id: this.recordingId,
      room_key: this.roomKey,
      map_name: this.metadata.mapName || '',
      pub_ip: this.metadata.pubIP || '',
      message_count: this.metadata.messageCount,
      duration: this.metadata.duration,
      file_size: this.metadata.fileSize,
      created_at: this.startTime,
      ended_at: this.endTime,
    };
    this.db.recording.upsert(p).catch(e => log.error('Failed to save recording to database:', e.message));
  }
}

// 录制器管理器
class RecorderManager {
  constructor(db) {
    this.db = db;
    this.recorders = new Map(); // roomKey -> RoomRecorder
    ensureRecordingsDir();
  }

  // 获取或创建房间的录制器
  getRecorder(roomKey) {
    if (!this.recorders.has(roomKey)) {
      this.recorders.set(roomKey, new RoomRecorder(roomKey, this.db));
    }
    return this.recorders.get(roomKey);
  }

  // 开始录制房间
  startRecording(roomKey) {
    const recorder = this.getRecorder(roomKey);
    return recorder.start();
  }

  // 暂停录制房间
  pauseRecording(roomKey) {
    const recorder = this.recorders.get(roomKey);
    if (!recorder) return null;
    return recorder.pause();
  }

  // 停止录制房间：有数据会落盘并返回录制信息；空录制返回 true；无录制器返回 null
  stopRecording(roomKey) {
    const recorder = this.recorders.get(roomKey);
    if (!recorder) return null;
    const result = recorder.stop();
    // 如果录制已停止，移除录制器
    if (!recorder.isRecording && !recorder.recordingId) {
      this.recorders.delete(roomKey);
    }
    return result;
  }

  // 记录消息
  recordMessage(roomKey, data, isBinary) {
    const recorder = this.recorders.get(roomKey);
    if (recorder && recorder.isRecording) {
      recorder.recordMessage(data, isBinary);
    }
  }

  // 更新房间元数据
  updateMetadata(roomKey, metadata) {
    const recorder = this.recorders.get(roomKey);
    if (recorder) {
      recorder.updateMetadata(metadata);
    }
  }

  // 获取录制状态
  getRecordingStatus(roomKey) {
    const recorder = this.recorders.get(roomKey);
    if (!recorder) {
      return { isRecording: false, recordingId: null };
    }
    return {
      isRecording: recorder.isRecording,
      recordingId: recorder.recordingId,
      startTime: recorder.startTime,
      messageCount: recorder.messages.length,
    };
  }

  // 一次性返回正在录制中的房间 key + 元信息 (供 admin 前端列表渲染)
  getActiveRecordings() {
    const out = [];
    for (const [roomKey, r] of this.recorders) {
      if (r.isRecording) {
        out.push({
          roomKey,
          recordingId: r.recordingId,
          startTime: r.startTime,
          messageCount: r.messages.length,
        });
      }
    }
    return out;
  }

  // 在所有房间录制结束时 (PM2 reload / shutdown) 把内存里没保存的强制保存掉
  flushAll() {
    let saved = 0;
    for (const [, r] of this.recorders) {
      if (r.isRecording && r.messages.length > 0) {
        try { r.pause(); saved++; } catch (e) {}
      }
    }
    if (saved > 0) log.info(`flushed ${saved} active recordings on shutdown`);
    return saved;
  }

  // 获取录制列表
  async getRecordingList(limit = 100) {
    try {
      const rows = await this.db.recording.list(limit);
      return rows.map(row => ({
        id: row.id,
        roomKey: row.room_key,
        mapName: row.map_name,
        pubIP: row.pub_ip,
        messageCount: Number(row.message_count) || 0,
        duration: Number(row.duration) || 0,
        fileSize: Number(row.file_size) || 0,
        createdAt: Number(row.created_at),
        endedAt: Number(row.ended_at),
        permanent: !!row.permanent,
        externalUrl: row.external_url || '',
      }));
    } catch (e) {
      log.error('Failed to get recording list:', e.message);
    }
    return [];
  }

  // 获取单条录制元数据 (DB)
  async getRecordingMeta(recordingId) {
    try {
      const row = await this.db.recording.getById(recordingId);
      if (row) {
        return {
          id: row.id,
          roomKey: row.room_key,
          mapName: row.map_name,
          pubIP: row.pub_ip,
          messageCount: Number(row.message_count) || 0,
          duration: Number(row.duration) || 0,
          fileSize: Number(row.file_size) || 0,
          createdAt: Number(row.created_at),
          endedAt: Number(row.ended_at),
        };
      }
    } catch (e) {
      log.error('Failed to get recording meta:', e.message);
    }
    return null;
  }

  // 获取录制数据
  getRecording(recordingId) {
    if (!isValidRecordingId(recordingId)) return null;
    try {
      const filepath = path.join(RECORDINGS_DIR, `${recordingId}.json`);
      if (fs.existsSync(filepath)) {
        const data = fs.readFileSync(filepath, 'utf8');
        return JSON.parse(data);
      }
    } catch (e) {
      log.error('Failed to load recording:', e.message);
    }
    return null;
  }

  getRecordingPath(recordingId) {
    if (!isValidRecordingId(recordingId)) return null;
    const filepath = path.join(RECORDINGS_DIR, `${recordingId}.json`);
    return fs.existsSync(filepath) ? filepath : null;
  }

  // 删除录制
  async deleteRecording(recordingId) {
    if (!isValidRecordingId(recordingId)) return false;
    try {
      const filepath = path.join(RECORDINGS_DIR, `${recordingId}.json`);
      if (fs.existsSync(filepath)) {
        fs.unlinkSync(filepath);
      }
      await this.db.recording.delete(recordingId);
      await this.db.share.deleteByRecording(recordingId).catch(() => {});
      log.info(`Deleted recording ${recordingId}`);
      return true;
    } catch (e) {
      log.error('Failed to delete recording:', e.message);
      return false;
    }
  }

  // ── 分享 token 管理 ────────────────────────────────────────
  // 一份录制可有多个 share token (撤销旧的再发新的也可); 默认永久有效
  async createShareToken(recordingId, expiresInMs = 0) {
    try {
      const rec = await this.db.recording.getById(recordingId);
      if (!rec) return null;
      await this.db.share.deleteByRecording(recordingId).catch(() => {});
      const token = crypto.randomBytes(12).toString('hex');
      const expiresAt = expiresInMs > 0 ? Date.now() + expiresInMs : 0;
      await this.db.share.insert(token, recordingId, Date.now(), expiresAt);
      return { token, expiresAt };
    } catch (e) {
      log.error('Failed to create share token:', e.message);
      return null;
    }
  }

  async resolveShareToken(token) {
    try {
      const row = await this.db.share.getByToken(token);
      if (!row) return null;
      if (row.expires_at > 0 && row.expires_at < Date.now()) {
        this.db.share.delete(token).catch(() => {});
        return null;
      }
      return { recordingId: row.recording_id, createdAt: row.created_at, expiresAt: row.expires_at };
    } catch (e) {
      log.error('Failed to resolve share token:', e.message);
      return null;
    }
  }

  async listShareTokens(recordingId) {
    try {
      const rows = await this.db.share.listByRecording(recordingId);
      return rows.map(r => ({
        token: r.token,
        createdAt: r.created_at,
        expiresAt: r.expires_at,
        custom_slug: r.custom_slug || '',
      }));
    } catch (e) { return []; }
  }

  async revokeShareToken(token) {
    try {
      await this.db.share.delete(token);
      return true;
    } catch (e) { return false; }
  }

  async setPermanent(recordingId, permanent) {
    if (!isValidRecordingId(recordingId)) return false;
    try {
      await this.db.recording.setPermanent(permanent ? 1 : 0, recordingId);
      return true;
    } catch (e) { return false; }
  }

  async cleanupOldRecordings(daysToKeep = 7) {
    const cutoffTime = Date.now() - (daysToKeep * 24 * 60 * 60 * 1000);
    const recordings = await this.getRecordingList(1000);
    
    let deletedCount = 0;
    for (const recording of recordings) {
      if (recording.createdAt < cutoffTime && !recording.permanent) {
        if (await this.deleteRecording(recording.id)) {
          deletedCount++;
        }
      }
    }
    
    if (deletedCount > 0) {
      log.info(`Cleaned up ${deletedCount} old recordings`);
    }
    
    return deletedCount;
  }
}

async function createRecorderManager(db) {
  const mgr = new RecorderManager(db);
  try {
    const cleaned = await mgr.cleanupOldRecordings(7);
    if (cleaned > 0) log.info(`Startup cleanup: removed ${cleaned} recordings older than 7 days`);
    await db.share.cleanupExpired(Date.now()).catch(() => {});
  } catch (e) { log.error('Startup cleanup error:', e.message); }
  return mgr;
}

module.exports = { createRecorderManager, RoomRecorder, RECORDINGS_DIR };
