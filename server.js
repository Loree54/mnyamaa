require('dotenv').config();
const WebSocket = require('ws');
const http = require('http');

const PORT = process.env.PORT || 3000;

// Read configs from env with defaults
let API_TOKEN = process.env.API_TOKEN || '';
let BASE_STAKE = Number(process.env.BASE_STAKE) || 100;
let MARTINGALE_MULTIPLIER = Number(process.env.MARTINGALE_MULTIPLIER) || 1.5;
let STOP_LOSS = Number(process.env.STOP_LOSS) || -2000;
let TAKE_PROFIT = Number(process.env.TAKE_PROFIT) || 500;
let CONTRACT_TYPE = process.env.CONTRACT_TYPE || 'DIGITOVER';
let BARRIER = Number(process.env.BARRIER) || 3;
let DURATION = Number(process.env.DURATION) || 2;
let DURATION_UNIT = process.env.DURATION_UNIT || 't';

const VOL_MARKETS = [
  'R_10', 'R_25', 'R_50', 'R_75', 'R_100',
  'R_10_1s', 'R_25_1s', 'R_50_1s', 'R_75_1s', 'R_100_1s'
];

let wsClient = null;
let botRunning = false;

let netProfit = 0;
let cycleCount = 0;

let tradableMarkets = [];
let activeContracts = new Set();
let contractTimeouts = {};

let wsDeriv = null;

const httpServer = http.createServer((req, res) => {
  res.writeHead(200);
  res.end('Deriv bot backend running');
});

httpServer.listen(PORT, () => {
  console.log(`HTTP + WebSocket server listening on port ${PORT}`);
});

const wss = new WebSocket.Server({ server: httpServer });

function sendToClient(msg) {
  if (wsClient && wsClient.readyState === WebSocket.OPEN) {
    wsClient.send(msg);
  }
}

wss.on('connection', (ws) => {
  wsClient = ws;
  sendToClient('🟢 Connected to backend');

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      if (data.command === 'start' && !botRunning) {
        // Update configs from UI input
        if (data.apiToken) API_TOKEN = data.apiToken;
        if (data.baseStake) BASE_STAKE = Number(data.baseStake);
        if (data.martingaleMultiplier) MARTINGALE_MULTIPLIER = Number(data.martingaleMultiplier);
        if (data.stopLoss) STOP_LOSS = Number(data.stopLoss);
        if (data.takeProfit) TAKE_PROFIT = Number(data.takeProfit);
        if (data.contractType) CONTRACT_TYPE = data.contractType;
        if (data.barrier) BARRIER = Number(data.barrier);
        if (data.duration) DURATION = Number(data.duration);
        if (data.durationUnit) DURATION_UNIT = data.durationUnit;

        startBot();
      } else if (data.command === 'stop' && botRunning) {
        stopBot();
      }
    } catch (e) {
      sendToClient('ERROR: Invalid JSON');
    }
  });

  ws.on('close', () => {
    wsClient = null;
    stopBot();
  });
});

function connectDerivWS() {
  wsDeriv = new WebSocket('wss://ws.binaryws.com/websockets/v3?app_id=1089');

  wsDeriv.on('open', () => {
    sendToClient('⏳ Authorizing with Deriv API...');
    wsDeriv.send(JSON.stringify({ authorize: API_TOKEN }));
  });

  wsDeriv.on('message', (raw) => {
    try {
      const data = JSON.parse(raw);
      if (data.msg_type === 'authorize') {
        if (data.error) {
          sendToClient(`ERROR: Authorization failed - ${data.error.message}`);
          stopBot();
          return;
        }
        sendToClient(`✅ Authorized. Balance: $${data.authorize.balance.toFixed(2)}`);
        checkTradableMarkets();
      } else if (data.msg_type === 'proposal') {
        const symbol = data.echo_req?.symbol || 'unknown';
        if (data.proposal && !tradableMarkets.includes(symbol)) {
          tradableMarkets.push(symbol);
          sendToClient(`🟢 Market tradable: ${symbol}`);
        }
      } else if (data.msg_type === 'buy') {
        if (data.buy?.contract_id) {
          activeContracts.add(data.buy.contract_id);
          contractTimeouts[data.buy.contract_id] = Date.now();
          sendToClient(`🎯 Bought contract on ${data.echo_req.parameters.symbol} | ID: ${data.buy.contract_id}`);
        }
      } else if (data.msg_type === 'proposal_open_contract') {
        const contract = data.proposal_open_contract;
        if (contract.is_sold) {
          handleContractClose(contract);
        }
      }
    } catch (e) {
      sendToClient('ERROR: Invalid message from Deriv WS');
    }
  });

  wsDeriv.on('close', () => {
    sendToClient('🔌 Deriv WS disconnected - reconnecting...');
    setTimeout(connectDerivWS, 5000);
  });

  wsDeriv.on('error', (err) => {
    sendToClient(`ERROR: Deriv WS error - ${err.message}`);
  });
}

function checkTradableMarkets() {
  tradableMarkets = [];
  VOL_MARKETS.forEach(symbol => {
    wsDeriv.send(JSON.stringify({
      proposal: 1,
      amount: BASE_STAKE,
      basis: 'stake',
      contract_type: CONTRACT_TYPE,
      currency: 'USD',
      duration: DURATION,
      duration_unit: DURATION_UNIT,
      symbol,
      barrier: BARRIER
    }));
  });
  setTimeout(() => {
    if (tradableMarkets.length === 0) {
      sendToClient('⚠️ No tradable markets found, retrying...');
      setTimeout(checkTradableMarkets, 10000);
    } else {
      startTradingCycle();
    }
  }, 5000);
}

function startTradingCycle() {
  if (!botRunning) return;
  cycleCount++;
  sendToClient(`♻️ Starting cycle ${cycleCount}`);

  contractTimeouts = {};
  activeContracts.clear();

  tradableMarkets.forEach((symbol, idx) => {
    setTimeout(() => {
      if (!botRunning) return;
      const buyReq = {
        buy: 1,
        price: BASE_STAKE,
        parameters: {
          amount: BASE_STAKE,
          basis: 'stake',
          contract_type: CONTRACT_TYPE,
          currency: 'USD',
          duration: DURATION,
          duration_unit: DURATION_UNIT,
          symbol,
          barrier: BARRIER
        }
      };
      wsDeriv.send(JSON.stringify(buyReq));
    }, idx * 200); // stagger buys
  });

  setTimeout(() => {
    updateBalanceAndCheck();
  }, 10000); // after 10s update balance and martingale
}

function updateBalanceAndCheck() {
  if (!botRunning) return;

  wsDeriv.send(JSON.stringify({ balance: 1 }));
  // We’ll handle balance response in wsDeriv.on('message')
}

function handleContractClose(contract) {
  const profit = parseFloat(contract.profit || 0);
  netProfit += profit;

  activeContracts.delete(contract.contract_id);
  delete contractTimeouts[contract.contract_id];

  sendToClient(`🏁 Closed ${contract.underlying} | P/L: $${profit.toFixed(2)} | Net: $${netProfit.toFixed(2)}`);

  // Martingale adjustment
  if (profit < 0) {
    BASE_STAKE = Math.min(BASE_STAKE * MARTINGALE_MULTIPLIER, 10000);
    sendToClient(`Martingale applied. New stake: $${BASE_STAKE.toFixed(2)}`);
  } else {
    BASE_STAKE = Number(process.env.BASE_STAKE) || 100; // reset base stake on profit
    sendToClient('Stake reset to base.');
  }

  checkStopConditions();
}

function checkStopConditions() {
  if (netProfit <= STOP_LOSS) {
    sendToClient('❌ Stop loss reached. Stopping bot.');
    stopBot();
  } else if (netProfit >= TAKE_PROFIT) {
    sendToClient('🏆 Take profit reached. Stopping bot.');
    stopBot();
  } else {
    // Start next cycle after delay
    setTimeout(startTradingCycle, 10000);
  }
}

function startBot() {
  if (botRunning) return;
  botRunning = true;
  netProfit = 0;
  cycleCount = 0;
  tradableMarkets = [];
  activeContracts.clear();
  contractTimeouts = {};
  connectDerivWS();
  sendToClient('🤖 Bot started');
}

function stopBot() {
  botRunning = false;
  netProfit = 0;
  cycleCount = 0;
  tradableMarkets = [];
  activeContracts.clear();
  contractTimeouts = {};
  if (wsDeriv) wsDeriv.close();
  sendToClient('🛑 Bot stopped');
}

// Timeout checker for contracts (optional)
setInterval(() => {
  if (!botRunning) return;
  const now = Date.now();
  Object.entries(contractTimeouts).forEach(([id, openTime]) => {
    if (now - openTime > 15000) { // 15 sec timeout
      activeContracts.delete(id);
      delete contractTimeouts[id];
      sendToClient(`⏰ Contract ${id} timeout removed`);
    }
  });
}, 5000);
