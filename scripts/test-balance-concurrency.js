/*
  Test script to simulate concurrent balance updates using BalanceService.
  Run with: node backend/scripts/test-balance-concurrency.js
*/
const { pool } = require('../db');
const { BalanceService } = require('../services/balanceService');

async function worker(name, amount) {
  const connection = await pool.getConnection();
  try {
    const res = await BalanceService.updateWalletBalance(connection, amount, `Concurrent update by ${name}`, `TEST_${name}_${Date.now()}`, 'test-runner', 'deposit', null, new Date());
    console.log(`${name} -> success: ${res.success}, newBalance: ${res.newBalance}, txId: ${res.transactionId}`);
  } catch (e) {
    console.error(`${name} -> error:`, e.message);
  } finally {
    connection.release();
  }
}

(async () => {
  try {
    // Create many concurrent small deposits
    const numWorkers = 10;
    const promises = [];
    for (let i = 0; i < numWorkers; i++) {
      promises.push(worker(`w${i+1}`, 1));
    }
    await Promise.all(promises);

    // Report final balance
    const connection = await pool.getConnection();
    const current = await BalanceService.getCurrentBalance(connection);
    console.log('Final balance after concurrent deposits: ', current);
    connection.release();
  } catch (err) {
    console.error('Test failed:', err);
  } finally {
    process.exit();
  }
})();
