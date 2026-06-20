const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'business@haitibiznis.com';

async function notifySignup(type, data) {
  const subjects = {
    user: 'New User Signup - MyPlopPlop',
    driver: 'New Driver Application - MyPlopPlop',
    merchant: 'New Merchant Signup - MyPlopPlop',
    store: 'New Store Created - MyPlopPlop'
  };
  const emojis = { user: '👤', driver: '🚗', merchant: '🏪', store: '🏬' };

  const subject = subjects[type] || 'New Signup - MyPlopPlop';
  const emoji = emojis[type] || '📢';

  let message = emoji + ' ' + subject + '\n\n';
  if (data.name) message += 'Name: ' + data.name + '\n';
  if (data.phone) message += 'Phone: ' + data.phone + '\n';
  if (data.email) message += 'Email: ' + data.email + '\n';
  if (data.role) message += 'Role: ' + data.role + '\n';
  if (data.vehicleType) message += 'Vehicle: ' + data.vehicleType + '\n';
  if (data.plate) message += 'Plate: ' + data.plate + '\n';
  if (data.storeName) message += 'Store: ' + data.storeName + '\n';
  if (data.category) message += 'Category: ' + data.category + '\n';
  if (data.referralPartner) message += 'Referral Partner: ' + data.referralPartner + '\n';

  console.log('[NOTIFY]', message.replace(/\n/g, ' | '));

  try {
    const params = new URLSearchParams();
    params.append('_subject', subject);
    params.append('message', message);
    Object.keys(data).forEach(k => {
      if (data[k]) params.append(k, String(data[k]));
    });
    await fetch('https://formsubmit.co/ajax/' + ADMIN_EMAIL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
      body: params.toString()
    });
    console.log('[NOTIFY] Email sent to', ADMIN_EMAIL);
  } catch (e) {
    console.error('[NOTIFY] Email error:', e.message);
  }
}

module.exports = { notifySignup };
