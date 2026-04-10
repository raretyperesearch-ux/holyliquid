# HolyLiquid — Supabase SQL Functions

Run these in the Supabase SQL editor AFTER running the main schema.
These are the RPC functions called by the round manager for atomic balance mutations.

---

```sql
-- Called when a player places a bet (deducts + locks amount)
CREATE OR REPLACE FUNCTION hl_place_bet(
  p_wallet text,
  p_amount numeric,
  p_round_id uuid,
  p_side text,
  p_idempotency_key uuid
)
RETURNS json
LANGUAGE plpgsql
AS $$
DECLARE
  v_balance numeric;
  v_bet_id uuid;
BEGIN
  -- Atomic balance check + deduct
  UPDATE hl_balances
  SET
    balance_usdc = balance_usdc - p_amount,
    locked_usdc  = locked_usdc  + p_amount,
    updated_at   = now()
  WHERE wallet = p_wallet
  AND   balance_usdc - locked_usdc >= p_amount
  RETURNING balance_usdc INTO v_balance;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'insufficient_balance';
  END IF;

  -- Insert bet
  INSERT INTO hl_bets (idempotency_key, round_id, wallet, side, amount)
  VALUES (p_idempotency_key, p_round_id, p_wallet, p_side, p_amount)
  RETURNING id INTO v_bet_id;

  -- Update pool
  IF p_side = 'pos' THEN
    UPDATE hl_rounds SET pos_pool = pos_pool + p_amount WHERE id = p_round_id;
  ELSE
    UPDATE hl_rounds SET neg_pool = neg_pool + p_amount WHERE id = p_round_id;
  END IF;

  RETURN json_build_object(
    'bet_id', v_bet_id,
    'balance_usdc', v_balance
  );
END;
$$;

-- Called on settlement: decreases locked amount
CREATE OR REPLACE FUNCTION hl_decrease_locked(p_wallet text, p_amount numeric)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE hl_balances
  SET locked_usdc = locked_usdc - p_amount, updated_at = now()
  WHERE wallet = p_wallet;
END;
$$;

-- Called on win: adds winnings to balance
CREATE OR REPLACE FUNCTION hl_increase_balance(p_wallet text, p_amount numeric)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO hl_balances (wallet, balance_usdc, locked_usdc)
  VALUES (p_wallet, p_amount, 0)
  ON CONFLICT (wallet) DO UPDATE
  SET balance_usdc = hl_balances.balance_usdc + p_amount,
      updated_at   = now();
END;
$$;

-- Called on deposit: credits balance
CREATE OR REPLACE FUNCTION hl_credit_deposit(p_wallet text, p_amount numeric, p_tx_hash text)
RETURNS numeric
LANGUAGE plpgsql
AS $$
DECLARE
  v_balance numeric;
BEGIN
  INSERT INTO hl_balances (wallet, balance_usdc, locked_usdc)
  VALUES (p_wallet, p_amount, 0)
  ON CONFLICT (wallet) DO UPDATE
  SET balance_usdc = hl_balances.balance_usdc + p_amount,
      updated_at   = now()
  RETURNING balance_usdc INTO v_balance;

  INSERT INTO hl_transactions (wallet, type, amount, tx_hash, note)
  VALUES (p_wallet, 'deposit', p_amount, p_tx_hash, 'on-chain deposit');

  RETURN v_balance;
END;
$$;
```
