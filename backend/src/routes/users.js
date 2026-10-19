const router = require('express').Router();
const db = require('../config/database');
const { requireAuth } = require('../middleware/auth');
const { createKycSession, isKycRequiredForCampaigns } = require('../services/kycProvider');
const { listCreatorCampaigns, listUserContributions } = require('../services/userDashboardService');
const asyncHandler = require('../utils/asyncHandler');
const { updateUserValidation, validateRequest } = require('../middleware/validation');

router.get('/me', requireAuth, asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    `SELECT id, email, name, wallet_public_key, wallet_type, role, kyc_status, kyc_completed_at, created_at, notification_preferences
     FROM users
     WHERE id = $1`,
    [req.user.userId]
  );
  if (!rows.length) return res.status(404).json({ error: 'User not found' });
  res.json({ ...rows[0], kyc_required_for_campaigns: isKycRequiredForCampaigns() });
}));

router.post('/me/kyc/start', requireAuth, asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    `SELECT id, email, name, role, kyc_status
     FROM users
     WHERE id = $1`,
    [req.user.userId]
  );
  if (!rows.length) return res.status(404).json({ error: 'User not found' });

  const user = rows[0];
  if (user.kyc_status === 'verified') {
    return res.json({
      status: 'verified',
      message: 'Identity verification is already complete.',
    });
  }

  try {
    const session = await createKycSession({ user });
    const { rows: updatedRows } = await db.query(
      `UPDATE users
       SET kyc_status = 'pending',
           kyc_provider_reference = COALESCE($2, kyc_provider_reference),
           kyc_completed_at = NULL
       WHERE id = $1
       RETURNING id, email, name, wallet_public_key, role, kyc_status, kyc_completed_at`,
      [user.id, session.providerReference || null]
    );

    res.status(201).json({
      status: updatedRows[0].kyc_status,
      provider: session.provider,
      provider_reference: session.providerReference,
      redirect_url: session.redirectUrl,
      session_token: session.sessionToken,
      user: {
        ...updatedRows[0],
        kyc_required_for_campaigns: isKycRequiredForCampaigns(),
      },
    });
  } catch (err) {
    res.status(502).json({ error: err.message || 'Could not start identity verification' });
  }
}));

// Deprecated alias of GET /api/campaigns/mine (see API.md).
router.get('/me/campaigns', requireAuth, asyncHandler(async (req, res) => {
  const campaigns = await listCreatorCampaigns(req.user.userId);
  res.json(campaigns);
}));

router.get('/me/stats', requireAuth, asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    `SELECT
      COUNT(*)::int AS total_campaigns,
      COALESCE(SUM(raised_amount), 0)::numeric AS total_raised,
      COUNT(*) FILTER (WHERE status = 'active')::int AS active_campaigns,
      COUNT(*) FILTER (WHERE status = 'funded')::int AS funded_campaigns,
      COUNT(*) FILTER (WHERE status = 'in_progress')::int AS in_progress_campaigns,
      COUNT(*) FILTER (WHERE status IN ('completed', 'closed', 'withdrawn', 'failed'))::int AS closed_campaigns
     FROM campaigns
     WHERE creator_id = $1`,
    [req.user.userId]
  );
  res.json(rows[0]);
}));

const { getCampaignBalance } = require('../services/stellarService');

router.get('/me/balance', requireAuth, asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    'SELECT wallet_public_key FROM users WHERE id = $1',
    [req.user.userId]
  );
  if (!rows.length) return res.status(404).json({ error: 'User not found' });

  const balance = await getCampaignBalance(rows[0].wallet_public_key);
  res.json({ balance, public_key: rows[0].wallet_public_key });
}));

// Deprecated alias of GET /api/contributions/mine (see API.md).
router.get('/me/contributions', requireAuth, asyncHandler(async (req, res) => {
  const rows = await listUserContributions(req.user.userId);
  if (rows === null) return res.status(404).json({ error: 'User not found' });
  res.json(rows);
}));

// PATCH /api/users/me — update display name and/or notification preferences
router.patch('/me', requireAuth, updateUserValidation, validateRequest, asyncHandler(async (req, res) => {
  const { name, notification_preferences: notificationPreferences } = req.body;

  const setClauses = [];
  const values = [];
  if (name !== undefined) {
    values.push(name);
    setClauses.push(`name = $${values.length}`);
  }
  if (notificationPreferences !== undefined) {
    values.push(JSON.stringify(notificationPreferences));
    setClauses.push(`notification_preferences = $${values.length}::jsonb`);
  }
  values.push(req.user.userId);

  const { rows } = await db.query(
    `UPDATE users SET ${setClauses.join(', ')} WHERE id = $${values.length}
     RETURNING id, email, name, wallet_public_key, wallet_type, role, kyc_status, kyc_completed_at, created_at, notification_preferences`,
    values
  );
  if (!rows.length) return res.status(404).json({ error: 'User not found' });
  res.json(rows[0]);
}));

module.exports = router;
