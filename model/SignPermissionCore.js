export function resolveSignPermission({ isMaster = false, coinDenied = false, gameAllowed = false, coinAllowed = false } = {}) {
  if (isMaster && !coinDenied) return 'master'
  if (gameAllowed && coinAllowed) return 'coin'
  if (gameAllowed) return 'game'
  if (coinAllowed) return 'coinOnly'
  return 'none'
}

export function filterCoinCandidates(values = [], blacklist = [], candidates = null) {
  const denied = new Set((blacklist || []).map(value => String(value ?? '').trim()).filter(Boolean))
  const allowed = [...new Set((values || []).map(value => String(value ?? '').trim()).filter(Boolean))]
    .filter(qq => !denied.has(qq))
  if (candidates === null) return allowed
  const candidateSet = new Set((candidates || []).map(value => String(value ?? '').trim()).filter(Boolean))
  return allowed.filter(qq => candidateSet.has(qq))
}
