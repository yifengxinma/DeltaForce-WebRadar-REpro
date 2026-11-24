// ============================================================
// aiTypes.js — 人机 BP 类名 → 短显示名（对齐 EspOverlay FormatAiTypeFromClass）
// 只改这个文件即可更新标签，无需重编 DLL
// ============================================================
(function (global) {
  function has(cn, k) {
    return cn && cn.indexOf(k) >= 0;
  }

  function aiLabelFromClass(cn) {
    if (!cn) return '人机';
    // 随从（须在泛 BOSS 前）
    if (has(cn, 'Attandent') || has(cn, 'Attendant') || has(cn, 'Minion')
      || has(cn, 'BP_DFMCharacter_AI_Boss05_HENC_C')
      || has(cn, 'BP_DFMCharacter_Boss07_NewGuard_C')
      || has(cn, 'Boss05_HENC') || has(cn, 'Boss07_NewGuard'))
      return '随从';
    if (has(cn, 'BP_DFMCharacter_AI_DT_RPG_C') || has(cn, 'RPG'))
      return '火箭兵';
    if (has(cn, 'BP_DFMCharacter_AI_Crocodile_C') || has(cn, 'Crocodile'))
      return '鳄鱼';
    if (has(cn, 'BP_DFMCharacter_AI_Shark_C') || has(cn, 'Shark'))
      return '鲨鱼';
    if (has(cn, 'BP_DFMAICharacter_HeavyMachineGun_C') || has(cn, 'HeavyMachineGun'))
      return '机枪兵';
    if (has(cn, 'BP_DFMCharacter_AI_BossRCV_C')
      || has(cn, 'BP_DFMCharacter_AI_Maurice_C')
      || has(cn, 'BP_DFMCharacter_AI_Reis_C')
      || has(cn, 'BP_DFMAICharacter_AI_Reis_C')
      || has(cn, 'BP_DFMAICharacter_Boss03_C')
      || has(cn, 'BP_DFMAICharacter_HelicopterPilot_C')
      || has(cn, 'BP_DFMCharacter_AI_Boss06_Warden_C')
      || has(cn, 'BP_DFMCharacter_AI_Boss07RCV_C')
      || has(cn, 'BP_DFMCharacter_AI_Boss08_Child_H800_C'))
      return 'Boss';
    if (has(cn, 'BP_DFMCharacter_AI_RCVPurifier_C'))
      return '洗消车';
    if (has(cn, 'BP_DFMCharacter_Boss05_C'))
      return '渡鸦Boss';
    if (has(cn, 'BP_DFMCharacter_AI_AlwaysFall_HSSniper_Tide_C')
      || has(cn, 'HSSniper') || has(cn, 'Sniper'))
      return '狙击兵';
    if (has(cn, 'Shield') || has(cn, 'Riot'))
      return '盾兵';
    if (has(cn, 'Flame') || has(cn, 'Flamer') || has(cn, 'Fire'))
      return '喷火兵';
    return '人机';
  }

  /** bots 实体显示名：优先已有 n，否则用 cn 映射 */
  function aiDisplayName(p) {
    if (!p) return '人机';
    if (p.n && p.n !== 'DefaultName' && p.n !== 'AI') return p.n;
    return aiLabelFromClass(p.cn || '');
  }

  global.aiLabelFromClass = aiLabelFromClass;
  global.aiDisplayName = aiDisplayName;
})(typeof window !== 'undefined' ? window : globalThis);
