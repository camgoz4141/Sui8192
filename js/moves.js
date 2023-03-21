const { ethos, Transaction } = require("ethos-connect");
const { contractAddress } = require("./constants");
const {
  eById,
  addClass,
  removeClass,
  directionToDirectionNumber,
  directionNumberToSymbol,
} = require("./utils");
const board = require("./board");
const queue = require("./queue");

let moves = {};
let preapproval;
let preapprovalNotified = false;
let executingMove = false;
const responseTimes = {
  total: 0,
  count: 0,
  start: null,
}

const constructTransaction = (direction, activeGameAddress) => {
  const transaction = new Transaction();
  transaction.moveCall({
    target: `${contractAddress}::game_8192::make_move`,
    arguments: [
      transaction.object(activeGameAddress),
      transaction.pure(direction)
    ]
  })
  return transaction;
};

const checkPreapprovals = async (activeGameAddress, walletSigner) => {
  if (walletSigner.type === "hosted") {
    return true;
  }

  try {
    const result = await ethos.preapprove({
      signer: walletSigner,
      preapproval: {
        packageObjectId: contractAddress,
        objectId: activeGameAddress,
        module: "game_8192",
        function: "make_move",
        description:
          "Pre-approve moves in the game so you can play without signing every transaction.",
        totalGasLimit: 50000000,
        maxTransactionCount: 25,
      },
    });

    preapproval = result.approved;
  } catch (e) {
    console.log("Error requesting preapproval", e);
    preapproval = false;
  }

  if (!preapprovalNotified && !preapproval) {
    removeClass(eById("preapproval"), "hidden");
    preapprovalNotified = true;
  }

  return preapproval;
};

const execute = async (
  directionOrQueuedMove,
  activeGameAddress,
  walletSigner,
  onComplete,
  onError
) => {
  if (executingMove) return;

  executingMove = true;

  if (board.active().gameOver) {
    onError({ gameOver: true });
    return;
  }

  await checkPreapprovals(activeGameAddress, walletSigner);

  const direction = directionOrQueuedMove.id
    ? directionOrQueuedMove.direction
    : directionOrQueuedMove;

  const directionNumber = directionToDirectionNumber(direction);
  
  if (responseTimes.count > 0 && (responseTimes.total / responseTimes.count) > 1000) {
    if (!directionOrQueuedMove.id) {
      directionOrQueuedMove = queue.add(direction);
    }

    if (queue.length() > 1) return;
  }
  
  const moveTransaction = constructTransaction(
    directionNumber,
    activeGameAddress
  );

  moves = {};

  const dataPromise = ethos.transact({
    signer: walletSigner,
    transactionInput: {
      transaction: moveTransaction,
      options: {
        contentOptions: {
          showBalanceChanges: true,
          showEffects: true,
          showEvents: true,
          showInput: true,
          showObjectChanges: true
        },
        requestType: 'WaitForLocalExecution'
      }
    }
  });

  ethos.hideWallet(walletSigner);

  let data;
  try {
    responseTimes.start = Date.now();

    data = await dataPromise;

    responseTimes.total += Date.now() - responseTimes.start;
    responseTimes.count += 1;
  } catch (e) {
    onError({ error: e.message });
  } finally {
    executingMove = false;
  }

  if (!data) return;

  console.log("move data", data)
  const { events, effects } = data;

  queue.remove(directionOrQueuedMove);
  
  if (effects?.status?.error === "InsufficientGas") {
    onError({});
    return;
  }

  if (
    (effects?.status?.error || "").indexOf(
      'name: Identifier("game_board_8192") }, function: 17, instruction: 8 }, 3)'
    ) > -1
  ) {
    onError({ gameOver: true });
    return;
  }

  if (effects?.status?.error) {
    const { error } = effects.status;
    onError({ error });
    return;
  }

  if (!effects) return;

  const { gasUsed } = effects;
  const { computationCost, storageCost, storageRebate } = gasUsed;
  const event = events.find((e) => e.type === `${contractAddress}::game_8192::GameMoveEvent8192`)

  const newBoard = board.convertInfo(event);

  if (newBoard.gameOver) {
    onError({ gameOver: true });
    return;
  }

  onComplete(newBoard, direction);

  const { fields } = event;
  const { last_tile: lastTile } = fields;
  const transaction = {
    gas: computationCost + storageCost - storageRebate,
    computation: computationCost,
    storage: storageCost - storageRebate,
    move: fields.direction,
    lastTile: {
      row: lastTile[0],
      column: fields.last_tile[1],
    },
    moveCount: fields.move_count,
  };
  const transactionElement = document.createElement("DIV");
  addClass(transactionElement, "transaction");
  transactionElement.innerHTML = `
    <div class='transaction-left'>
      <div class='transaction-count'>
        ${parseInt(transaction.moveCount) + 1}
      </div>
      <div class='transaction-direction'>
        ${directionNumberToSymbol(transaction.move.toString())}
      </div>
    </div>
    <div class="transaction-right">
      <div class=''>
        <span class="light">
          Computation:
        </span>
        <span>
          ${transaction.computation}
        </span>
      </div>
      <div class=''>
        <span class="light">
          Storage:
        </span>
        <span>
          ${transaction.storage}
        </span>
      </div>
      <div class=''>
        <span class='light'>
          Gas:
        </span>
        <span class=''>
          ${transaction.gas}
        </span>
      </div>
    </div>
  `;

  eById("transactions-list").prepend(transactionElement);
  removeClass(eById("transactions"), "hidden");

  if (queue.length() > 0) {
    const queuedMove = queue.next()
    execute(
      queuedMove,
      activeGameAddress,
      walletSigner,
      onComplete,
      onError
    )
  }
};

const reset = () => (moves = []);

module.exports = {
  checkPreapprovals,
  constructTransaction,
  execute,
  reset,
};
