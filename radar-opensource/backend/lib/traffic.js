/**
 * traffic.js — 全局流量统计 (DL = pub→server, UL = server→sub)
 *
 * 抽出动机:
 *   relay.js 之前 gTraffic 是 module-level 对象, 多个 setInterval 散在不同位置改它,
 *   ws-handler 和 admin-http 都直接读字段。封装后:
 *   - 上行/下行累加只通过 addDl/addUl, 防止外部脏写
 *   - 衰减 interval 自带, 不用 relay.js 主流程 wire
 *   - 单测可 new Traffic(); traffic.addDl(100); traffic.snapshot()
 *
 * decayMs=2000: 2 秒无数据则 PerSec 归零, 避免界面显示僵尸速率
 */

class Traffic {
  constructor({ decayMs = 2000 } = {}) {
    this.dlTotal = 0;
    this.ulTotal = 0;
    this._dlWin  = 0;
    this._ulWin  = 0;
    this._winStart = Date.now();
    this.dlPerSec = 0;
    this.ulPerSec = 0;
    this._decayMs = decayMs;
    this._decayTimer = setInterval(() => this._decay(), decayMs);
    if (this._decayTimer.unref) this._decayTimer.unref();
  }

  // 累加下行(pub→server), 即转入流量
  addDl(bytes) {
    if (!bytes) return;
    this.dlTotal += bytes;
    this._dlWin  += bytes;
    this._tick();
  }

  addUl(bytes) {
    if (!bytes) return;
    this.ulTotal += bytes;
    this._ulWin  += bytes;
    this._tick();
  }

  // 1s 滚窗结算: 把窗内累计搬到 PerSec, 重置窗口
  _tick() {
    const now = Date.now();
    if (now - this._winStart >= 1000) {
      this.dlPerSec = this._dlWin;
      this.ulPerSec = this._ulWin;
      this._dlWin = 0;
      this._ulWin = 0;
      this._winStart = now;
    }
  }

  _decay() {
    if (Date.now() - this._winStart >= this._decayMs) {
      this.dlPerSec = 0;
      this.ulPerSec = 0;
      this._dlWin = 0;
      this._ulWin = 0;
      this._winStart = Date.now();
    }
  }

  snapshot() {
    return {
      dlTotal: this.dlTotal,
      ulTotal: this.ulTotal,
      dlPerSec: this.dlPerSec,
      ulPerSec: this.ulPerSec,
    };
  }

  // 测试/进程退出时调用, 否则 timer keep alive
  stop() {
    if (this._decayTimer) {
      clearInterval(this._decayTimer);
      this._decayTimer = null;
    }
  }
}

module.exports = { Traffic };
