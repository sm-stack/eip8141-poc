# EIP-8141 / 8250 / 8272 현행화 및 구현 계획

> 기준 스펙: `.context/eip-8141.md`(현행 드래프트), `.context/eip-8250.md`, `.context/eip-8272.md`
> 감사 결과(2026-07-05): 전 스택(geth/viem/solidity/contracts/docs)이 **구버전 8141 드래프트** 기준으로 구현됨.
> 8250/8272는 전 컴포넌트 미구현(0%).

---

## Phase 0 — 스펙 충돌 해소 (구현 전 결정 사항)

8250/8272는 signatures 필드가 없던 구버전 8141을 베이스로 작성되어 있어, 세 스펙을 동시에
구현하려면 아래 사항을 PoC 차원에서 먼저 확정해야 한다. **이 결정들은 본 파일이 single source
of truth이며, 변경 시 여기부터 갱신한다.**

### 0.1 통합 트랜잭션 페이로드 (세 EIP 적용 후 최종형)

```
[chain_id,
 nonce_keys,                 # 8250 (기존 nonce 대체, uint256 list, strictly increasing)
 nonce_seq,                  # 8250 (uint64)
 sender,
 frames,                     # 8141 현행: [[mode, flags, target, gas_limit, value, data], ...]
 signatures,                 # 8141 현행: [[scheme, signer, msg, signature], ...]
 max_priority_fee_per_gas,
 max_fee_per_gas,
 max_fee_per_blob_gas,
 blob_versioned_hashes,
 recent_root_references]     # 8272: [[source_id, slot, root], ...]
```

- Phase 1 완료 시점의 중간형은 `[chain_id, nonce, sender, frames, signatures, fees..., blob_hashes]` (9필드).
- Phase 2에서 `nonce` → `nonce_keys, nonce_seq`로 교체 (10필드).
- Phase 3에서 `recent_root_references` 추가 (11필드).
- 각 Phase마다 페이로드/sig hash가 바뀌므로 **devnet은 Phase 경계마다 재생성**한다.

### 0.2 Sig hash 규칙

- 현행 8141 방식 채택: **empty-msg 서명의 raw `signature` 바이트만 elide**.
  `compute_sig_hash`에서 VERIFY frame data는 elide하지 않는다 (8250/8272 본문의
  "VERIFY-frame data elided" 문구는 구버전 잔재로 무시).
- 8272의 `recent_root_references`는 sig hash에 포함 (elide 대상 아님).

### 0.3 Opcode 번호 배정 (충돌 해소)

| Opcode | 번호 | 출처 | 비고 |
|---|---|---|---|
| `APPROVE` | `0xAA` | 8141 | 유지 |
| `TXPARAM` | `0xB0` | 8141 | 기존 TXPARAMLOAD 대체 |
| `FRAMEDATALOAD` | `0xB1` | 8141 | 기존 TXPARAMSIZE 제거 후 재사용 |
| `FRAMEDATACOPY` | `0xB2` | 8141 | 기존 TXPARAMCOPY 대체 |
| `FRAMEPARAM` | `0xB3` | 8141 | 신규 |
| `SIGPARAM` | `0xB4` | 8141 | 신규 |
| `RECENTROOTREFLOAD` | **`0xB5`** | 8272 | 스펙의 0xB4는 SIGPARAM과 충돌 → **0xB5로 이동 (PoC 결정)** |

### 0.4 TXPARAM 인덱스 배정 (충돌 해소)

| param | 값 | 출처 |
|---|---|---|
| 0x00 | tx type | 8141 |
| 0x01 | `nonce_seq` (Phase 1까지는 `nonce`) | 8141→8250 |
| 0x02 | `sender` | 8141 |
| 0x03–0x05 | fee 필드들 | 8141 |
| 0x06 | max cost | 8141 |
| 0x07 | `len(blob_versioned_hashes)` | 8141 |
| 0x08 | `compute_sig_hash(tx)` | 8141 |
| 0x09 | `len(frames)` | 8141 |
| 0x0A | 현재 실행 중인 frame index | 8141 |
| 0x0B | `len(signatures)` | 8141 |
| **0x0C** | `nonce_keys[0]` | 8250 (스펙 0x0B에서 shift) |
| **0x0D** | pre-state legacy nonce | 8250 (스펙 0x0C에서 shift) |
| **0x0E** | `len(nonce_keys)` | 8250 (스펙 0x0D에서 shift) |
| **0x0F** | `nonce_keys_hash(tx)` | 8250 (스펙 0x0E에서 shift) |
| **0x10** | `len(recent_root_references)` | 8272 (스펙 0x0D/0x0F 모순 → 0x10으로 확정) |

### 0.5 시스템 컨트랙트 주소 (스펙 TBD → PoC 확정)

| 이름 | 주소 | 코드 |
|---|---|---|
| `EXPIRY_VERIFIER` | `0x…8141` | 스펙 명시 런타임: `0x60083614600a575f5ffd5b5f3560c01c4211601657005b5f5ffd` |
| `NONCE_MANAGER` | **`0x…8250`** | `0x60006000fd` (revert(0,0)) — 스토리지는 프로토콜만 기록 |
| `RECENT_ROOT_ADDRESS` | **`0x…8272`** | `RECENT_ROOT_CODE`가 스펙 TBD → **geth 네이티브 시스템 컨트랙트로 구현** (0.6 참고) |

### 0.6 8272 미확정 사항에 대한 PoC 결정

1. **`RECENT_ROOT_CODE`**: 쓰기 로직이 `current_slot`을 필요로 하는데 EVM에 slot opcode가
   없으므로 순수 바이트코드로 구현 불가. → geth에서 **주소 기반 네이티브 핸들러**(stateful
   precompile 방식)로 구현하고, 주소에는 마커 코드(예: `0x60006000fd`와 구분되는 placeholder)를
   설치한다. 온체인 코드 해시는 합의에 참여하지 않는 실행 디스패치 키로만 사용.
2. **`current_slot` 소스**: 스펙은 EIP-7843 `slotNumber`를 요구하나 devnet(`--dev`)에는 CL이
   없음. → `SlotProvider` 인터페이스로 추상화하고, devnet에서는 `timestamp / SECONDS_PER_SLOT(12)`
   근사를 사용. 7843 연동은 out-of-scope로 문서화.
3. delegatecall/callcode로는 RECENT_ROOT 스토리지에 도달할 수 없으므로(스토리지 컨텍스트가
   호출자 쪽) "direct call만 쓰기 가능" 요건은 자연 충족 — 네이티브 구현에서도 동일하게
   `ADDRESS == RECENT_ROOT_ADDRESS`일 때만 쓰기.

### 0.7 기타 결정

- **포크 게이팅**: PoC는 기존 방식(osaka+ 단일 활성화) 유지. 8250/8272도 같은 포크에서 활성화하되
  코드상 기능별 플래그(`EnableKeyedNonces`, `EnableRecentRoots`)로 분리해 Phase별 머지 가능하게 함.
- **MLDSA 계정**: 현행 스펙의 서명 scheme은 SECP256K1(0x0)/P256(0x1)뿐이고 0x2+는 reserved.
  → MLDSA는 tx-level signatures로 옮기지 않고 **frame-data 방식 유지** (스펙 합치, 문서에 명시).
- **커밋 컨벤션**: CLAUDE.md 준수 (conventional commits, 작은 단위, co-author 없음).

---

## Phase 1 — EIP-8141 현행 드래프트로 업데이트

가장 큰 Phase. 순서: geth → solidity 컴파일러 → contracts → viem → docs → e2e.
(컴파일러가 먼저 빌드되어야 contracts 테스트 가능, geth가 먼저 있어야 viem e2e 가능)

### 1.1 geth: 타입/인코딩 (`8141-geth/core/types/tx_frame.go`)

1. **`TxSignature` 타입 신설**
   ```go
   type TxSignature struct {
       Scheme    uint8          // 0x0 SECP256K1, 0x1 P256
       Signer    common.Address // 20 bytes
       Msg       []byte         // len 0 (canonical sig hash) 또는 len 32 (nonzero)
       Signature []byte         // 65B (v||r||s) 또는 128B (r||s||qx||qy)
   }
   ```
   RLP: `[scheme, signer, msg, signature]`.
2. **`Frame`에 `Flags uint8`, `Value *uint256.Int` 추가**, RLP를
   `[mode, flags, target, gas_limit, value, data]`로 변경 (Encode/DecodeRLP 양쪽).
3. **`FrameTx`에 `Signatures []TxSignature` 추가** (`Frames` 다음 위치).
4. **디코드 시 정적 제약** (`DecodeRLP` 또는 별도 `sanityCheck`, 스펙 "Constraints" 섹션):
   - `1 <= len(frames) <= 64` (`MAX_FRAMES=64` 상수 추가)
   - `mode < 3`, `flags < 8`
   - `frame.mode != SENDER ⇒ frame.value == 0`
   - `ATOMIC_BATCH_FLAG(bit 2)`가 마지막 프레임에 설정되면 invalid
   - `Σ gas_limit`이 uint64 오버플로하면 invalid
   - 서명: `scheme ∈ {0,1}`, `len(signer)==20`, `len(msg) ∈ {0,32}`, `msg != 0x00*32`,
     scheme별 signature 길이(65/128)
   - expiry frame(`target==EXPIRY_VERIFIER && mode==VERIFY`): `flags==0`, `value==0`,
     `len(data)==8`, 트랜잭션당 최대 1개
5. **Sig hash 재구현**: tx 복사 → empty-msg 서명의 `Signature = nil` → `keccak(0x06 || rlp(tx))`.
   기존 VERIFY-data elision 로직이 있으면 제거.
6. **Receipt**: frame receipt status 시맨틱 확정 — `0`=revert, `1`=success, **`3`=skipped**
   (atomic batch 실패로 미실행). 기존 approve status 2/3/4 인코딩 제거. `payer` 필드 유지.

**테스트**: RLP round-trip(모든 필드 조합), 정적 제약 위반 케이스 전수, sig hash 벡터
(viem과 공유할 test vector를 `.context/test-vectors/`에 JSON으로 export).

### 1.2 geth: tx-level 서명 검증 (신규 `core/types/tx_frame_sig.go` 또는 core 내)

1. `ValidateFrameTxSignatures(tx, sigHash)`:
   - `msg` 결정: empty → sigHash, 32B nonzero → msg 자체
   - SECP256K1: `crypto.Ecrecover` → 주소 비교 (v는 0/1 raw parity — viem 커밋 6e3af4d5와 일치 확인)
   - P256: `signer == keccak256(qx||qy)[12:]` 확인 후 `crypto/secp256r1` 검증
2. 실행 진입 전(모든 프레임 실행 전) 전체 검증, 하나라도 실패 시 tx invalid.
3. 서명 가스 상수: `SigGasSecp256k1=2800`, `SigGasP256=6700` (`params/protocol_params.go`).

### 1.3 geth: 실행 로직 (`core/state_transition.go:783-946` executeFrameTx 일대)

1. **SENDER frame value 전송**: `CanTransfer` 실패 시 frame revert (tx invalid 아님).
   top-level `CALLVALUE = frame.value`.
2. **APPROVE 시맨틱 재작성** (`core/vm/instructions_frame.go:53-101`):
   - scope 비트마스크: PAYMENT=0x1, EXECUTION=0x2, BOTH=0x3
   - 허용 검사: `scope != 0 && scope & ^(frame.flags & 0x3) == 0` (frame.flags 기반 — flags 필드 신설로 가능해짐)
   - `ADDRESS != resolved_target` → revert
   - `APPROVE_EXECUTION`: sender_approved 이미 true → revert; `resolved_target != sender` → revert
   - `APPROVE_PAYMENT`: payer 이미 설정 → revert; **`sender_approved == false` → revert**; 잔액 부족 → revert;
     nonce 증가 + max cost 징수
   - `APPROVE_BOTH`: 위 조건 결합
3. **Atomic batch**: 배치 시작 시 statedb snapshot 저장. 배치 내 프레임 실패 시
   snapshot으로 롤백 + 잔여 배치 프레임 skipped(status 3) 처리 + skipped 프레임 gas_limit은
   환불 풀에 가산. *(주의: 8250 대비, payment approve의 효과는 배치 롤백에서 제외되어야 하므로
   "approval effects"를 별도 저널로 분리하는 구조를 이번에 마련 — 1.3.7 참고)*
4. **Expiry verifier**: fork 활성화 시 `EXPIRY_VERIFIER(0x…8141)`에 스펙 런타임 코드 설치
   (`core/genesis.go` 또는 fork transition). VERIFY 프레임 중 canonical 코드 실행 시
   TIMESTAMP 허용 (validation tracer의 banned opcode 예외).
5. **Default code 갱신** (커밋 cc0a091의 기존 구현 수정):
   - VERIFY: `allowed_scope = frame.flags & 0x3`; `0`이면 revert;
     `allowed_scope & EXECUTION != 0 && resolved_target != sender`면 revert;
     **`tx.signatures`에서** `scheme==SECP256K1 && signer==resolved_target && msg==empty`인
     항목 존재 확인 (기존 frame-data 서명 파싱 제거); `APPROVE(allowed_scope)` 수행
   - SENDER/DEFAULT: empty-code call과 동일하게 성공
6. **프레임 간 TSTORE/TLOAD 폐기** 확인 (미구현이면 frame 경계에서 transient storage clear).
7. **Approval effects 저널 분리**: `sender_approved`/`payer`/nonce 증가/비용 징수를
   frame revert journal 바깥의 tx-scoped 레코드로 관리. Phase 1에서는 "payment approve가 있는
   프레임은 VERIFY라 실패 시 tx 전체 invalid"이므로 동작 차이가 없지만, 8250의
   "approval effects MUST NOT be reverted by later frame revert/atomic-batch rollback"
   요건을 여기서 미리 구조화한다.

### 1.4 geth: introspection opcode 재편 (`core/vm/instructions_frame.go`, jump table)

1. `TXPARAMLOAD/TXPARAMSIZE/TXPARAMCOPY` 제거.
2. 신규 구현 (0.3/0.4 표 기준):
   - `TXPARAM(0xB0)`: gas 2, 스택 `param` 1개 pop → 값 push. param 0x00–0x0B.
     미정의 param → exceptional halt.
   - `FRAMEDATALOAD(0xB1)`: gas 3, pop `offset`, `frameIndex` → CALLDATALOAD 시맨틱으로
     해당 frame `data`에서 32바이트 로드. frameIndex OOB → halt.
   - `FRAMEDATACOPY(0xB2)`: CALLDATACOPY 가스(기본 3 + word copy + memory expansion),
     pop `memOffset, dataOffset, length, frameIndex`. OOB → halt.
   - `FRAMEPARAM(0xB3)`: gas 2, pop `frameIndex`(top), `param`. param 0x00–0x08
     (target, gas_limit, mode, flags, len(data), status, allowed_scope, atomic_batch, value).
     status는 과거 프레임만(현재/미래 → halt), 값은 0(실패)/1(성공) — skipped 프레임 status는
     스펙상 0/1만 정의되어 있으므로 0으로 반환하고 docs에 명시.
   - `SIGPARAM(0xB4)`: gas 2, pop `signatureIndex`(top), `param`. param 0x00–0x03
     (signer, scheme, msg, len(signature)). raw signature bytes는 노출 금지.
3. jump table (osaka/fork ruleset)에 등록, 가스 상수는 `params/protocol_params.go`.

### 1.5 geth: 가스 회계

1. `FRAME_TX_PER_FRAME_COST = 475` 상수 추가.
2. `tx_gas_limit = 15000 + 475*len(frames) + calldata7623(rlp(signatures)) + calldata7623(rlp(frames)) + Σ sig_gas + Σ frame.gas_limit` — `TotalGas()`(tx_frame.go)와 intrinsic 계산부 양쪽 갱신.
3. 환불: `Σ frame.gas_limit - total_gas_used`(skipped 프레임 gas 포함)를 payer에 환불하고
   block gas pool에 반환.
4. `frame.value` 전송 가스는 일반 CALL 규칙 (별도 항목 아님).

### 1.6 geth: framepool/멤풀 (`core/txpool/framepool/framepool.go`, `core/vm/frame_validation_tracer.go`)

1. 수신 시 **서명 전체 검증**을 프레임 시뮬레이션 전에 수행, 서명 가스를 `MAX_VERIFY_GAS(100k)`
   예산에 포함.
2. validation prefix 인식 갱신:
   - 4가지 prefix(self_verify / deploy+self_verify / only_verify+pay / deploy+only_verify+pay)
   - **expiry_verify 프레임은 prefix 매칭에서 skip**
   - prefix 내 `ATOMIC_BATCH_FLAG` 금지
3. expiry deadline이 현재 timestamp보다 과거인 tx는 drop (수신·recheck 시).
4. banned opcode 목록을 스펙과 대조 갱신 (TIMESTAMP는 expiry verifier canonical 코드 예외,
   GAS는 직후 *CALL 예외, CREATE/CREATE2/SETDELEGATE는 첫 deploy frame 예외).
5. **canonical paymaster**: 1.9에서 확정되는 `CanonicalPaymaster` 런타임 코드 해시로 매칭,
   `reserved_pending_cost(paymaster)` + `pending_withdrawal_amount` 회계 구현
   (admission 시 예약, 포함/교체/축출/리오그 시 해제).
6. **non-canonical paymaster**: pending tx ≤ 1 (`MAX_PENDING_TXS_USING_NON_CANONICAL_PAYMASTER`).
7. sender당 pending 1개 + 동일 nonce replacement fee-bump 규칙 확인.
8. 블록 수신 시 revalidation: sender/스토리지/paymaster 의존성 추적 재검증 (기존 로직 보강).

### 1.7 geth: RPC (`internal/ethapi`)

- tx JSON에 `frames[].flags`, `frames[].value`, `signatures[]` 직렬화/역직렬화.
- receipt에 `payer`, `frameReceipts[] {status(0/1/3), gasUsed, logs}`.
- `eth_sendRawTransaction` 경로의 디코더가 새 스키마 검증을 타는지 확인.

### 1.8 solidity 컴파일러 (`solidity-eip8141`)

1. `libevmasm/Instruction.h/.cpp`: `TXPARAMSIZE/TXPARAMCOPY` 제거,
   `TXPARAM(0xB0, 1in/1out)`, `FRAMEDATALOAD(0xB1, 2in/1out)`, `FRAMEDATACOPY(0xB2, 4in/0out)`,
   `FRAMEPARAM(0xB3, 2in/1out)`, `SIGPARAM(0xB4, 2in/1out)` 등록. `APPROVE(0xAA, 3in/0out)` 유지.
2. `libevmasm/GasMeter.cpp` / `SemanticInformation.cpp`: 티어(Base=2 / VeryLow=3 / copy류) 및
   side-effect 정보 갱신 (APPROVE는 terminating, TXPARAM류는 pure-ish).
3. Yul 빌트인 노출명: `txparam(p)`, `framedataload(offset, idx)`, `framedatacopy(m, d, l, idx)`,
   `frameparam(p, idx)`, `sigparam(p, idx)`, `approve(o, l, scope)` — inline assembly에서 사용 가능해야 함.
4. 컴파일러 빌드 + 기존 테스트 통과 확인, contracts 빌드 파이프라인(Makefile)의 컴파일러 경로 확인.

### 1.9 contracts (`contracts/`)

1. **`FrameTxLib.sol` 전면 개정**:
   - scope 상수: `SCOPE_PAYMENT=0x1`, `SCOPE_EXECUTION=0x2`, `SCOPE_EXECUTION_AND_PAYMENT=0x3`
     (기존 0/1/2 제거 — **모든 사용처 마이그레이션 필수**)
   - PARAM 상수를 0.4 표(0x00–0x0B)로 교체, 0x10–0x15 비표준 인덱스 제거
   - 신규 래퍼: `txParam(p)`, `frameParam(p, idx)`, `frameDataLoad(off, idx)`,
     `frameDataCopy(...)`, `sigParam(p, idx)`, `sigHash()`, `currentFrameIdx()` 등
2. **scope 마이그레이션 대상**: `Simple8141Account.sol`, `SimplePaymaster.sol`,
   `ERC20Paymaster.sol`, `example/light-account/LightAccount8141.sol`,
   `example/coinbase-smart-wallet/CoinbaseSmartWallet8141.sol`,
   `example/kernel/**` (특히 `ValidationManager8141.sol`), `example/mldsa/MLDSA8141Account.sol`,
   `test-helpers/*.sol`
3. **서명 소스 전환**:
   - `Simple8141Account`: tx-level `signatures` 사용 예제로 전환 — SIGPARAM으로
     `signer/scheme/msg`를 조회해 owner와 대조 (raw bytes는 프로토콜이 이미 검증)
   - Kernel/LightAccount/CoinbaseSmartWallet: frame-data 서명 유지 (bespoke 검증 패턴 시연,
     스펙상 허용) — 단 canonical sig hash는 `TXPARAM(0x08)` 사용으로 통일
   - MLDSA: frame-data 유지 (0.7 결정)
4. **`CanonicalPaymaster.sol` 신설** (SimplePaymaster 대체 또는 병행):
   - 단일 secp256k1 서명자 `ecrecover` 검증 → `APPROVE(SCOPE_PAYMENT)`
   - **timelocked withdrawal**: `initiateWithdrawal(amount)` → `WITHDRAWAL_DELAY` 경과 후
     `finalizeWithdrawal()`; 그 외 ETH 유출 경로 없음
   - `pendingWithdrawal()` view — framepool의 `pending_withdrawal_amount` 조회용
   - 런타임 코드 해시를 geth framepool(1.6.5)과 devnet 문서에 고정
5. **신규 예제/테스트**: atomic batch(approve+swap 롤백), SENDER frame value 전송,
   expiry verifier 프레임, P256(WebAuthn) tx-level 서명 계정
6. forge 테스트 전면 통과 (새 컴파일러로 빌드)

### 1.10 viem (`viem-eip8141/src/eip8141/`)

1. **types**: `frame.ts`에 `flags: number`, `value: bigint` 추가;
   `TxSignature {scheme, signer, msg, signature}` 신설; `transaction.ts`에 `signatures` 추가.
2. **serializers.ts / parsers.ts**: 9필드 페이로드, frame 6필드, signatures 리스트
   (RLP canonical zero 인코딩 주의 — 기존 커밋 1f4e8ba4 패턴 준수).
3. **utils/computeSigHash.ts**: empty-msg 서명 raw bytes elision으로 교체
   (VERIFY-data elision 제거). geth와 **공유 test vector**(1.1)로 교차 검증.
4. **utils/eoa.ts / accounts/toEoaFrameAccount.ts**: 서명을 frame data 대신
   `tx.signatures` 항목(`scheme=0/1, signer, msg='0x', signature`)으로 생성;
   approval scope는 VERIFY frame의 `flags`(bit 0-1)로 지정. 커밋 6729a95의
   "paymaster 있으면 execution-only" 로직을 flags 기반으로 이식.
5. **가스 추정**: `prepareFrameTransaction.ts`에 스펙 공식 구현
   (15000 + 475/frame + EIP-7623 calldata(rlp(sigs)+rlp(frames)) + sig gas + Σ frame gas).
   VERIFY gasLimit probe(커밋 b2390f61) 로직과 통합.
6. **formatters.ts / receipt**: status 시맨틱 0/1/3(skipped)로 정정, `cumulativeGasUsed` 확인.
7. **헬퍼**: `makeExpiryFrame(deadline: bigint)` (target 0x…8141, 8바이트 BE data, flags 0),
   atomic batch 빌더(`withAtomicBatch([...])` — 마지막 프레임 flag 해제 검증).
8. **accounts/toSimple8141Account.ts, toFrameAccount.ts**: flags/value/signatures 반영.
9. 단위 테스트 + sig hash 교차 벡터 테스트.

### 1.11 docs 갱신

- `docs/eip-8141-overview.md`: 페이로드 9필드+signatures, frame 6필드, scope 비트마스크,
  opcode 5개 체계(0xB0–0xB4), 가스 공식(475/frame, sig gas), **MAX_FRAMES 1,000 → 64**,
  receipt status 3, expiry verifier, atomic batch 섹션 신설
- `docs/client-modifications.md`: TXPARAMLOAD/SIZE/COPY 서술 제거, 신규 opcode/서명 검증
  파이프라인/framepool 규칙 반영
- `docs/reference-implementations.md`, `README.md`: 컴포넌트별 지원 현황 표 갱신
- `devnet/`: expiry verifier predeploy, canonical paymaster 코드 해시 문서화

### 1.12 Phase 1 인수 기준 (e2e, `devnet/` + viem e2e)

- [x] EOA default code로 단순 ETH 전송 (SENDER frame `value` 사용, 프레임 2개)
- [x] tx-level P256 서명으로 스마트 계정 tx 성공
- [x] atomic batch: 두 번째 프레임 revert 시 첫 프레임 상태 롤백 + receipt status [1?, 3] + skipped gas 환불 확인
- [x] expiry frame: 유효 deadline 성공 / 만료 시 tx invalid + 멤풀 drop
- [x] canonical paymaster 스폰서 tx (only_verify+pay prefix) 멤풀 통과
- [x] 구버전 인코딩 tx가 디코드 단계에서 거부됨
- [x] geth/viem sig hash 교차 벡터 일치

---

## Phase 2 — EIP-8250 (Keyed Nonces)

### 2.1 geth: 타입/디코딩

- `FrameTx.Nonce uint64` → `NonceKeys []*uint256.Int` + `NonceSeq uint64` (페이로드 0.1 순서).
- 디코더 규칙: `1 <= len(nonce_keys) <= 16`, canonical RLP 정수, **strictly increasing**,
  `0` 키는 `[0]` 단독일 때만, `nonce_seq < 2^64`.
- sig hash에 자연 반영 (필드 교체이므로 Phase 경계에서 기존 tx 전부 무효 — devnet 재생성).

### 2.2 geth: 상태/검증

- `NONCE_MANAGER(0x…8250)` 활성화 시 설치: code `0x60006000fd`, nonce 1, empty storage.
- 슬롯: `keccak256(left_pad_32(sender) || bytes32(nonce_key))`.
- stateful validity (기존 nonce 체크 위치): `nonce_seq < 2^64-1` &&
  모든 key에 대해 `nonce_seq == current_nonce_seq(sender, key)`
  (key 0 → account nonce, 그 외 → NONCE_MANAGER storage, absent=0).

### 2.3 geth: 소비 로직 (payment-scoped APPROVE 내부)

1. `nonce_keys == [0]`: 기존대로 `increment_account_nonce(sender)`
   (`> 2^64-1`이 되면 exceptional halt, approval 효과 없음).
2. 그 외: 각 key의 `raw_before` 읽기 → `first_use_count`(0인 것 개수) 계산 →
   `20000 * first_use_count` 가스 확인/차감(부족 시 OOG, 효과 없음) →
   전 key 슬롯에 `nonce_seq + 1` 기록.
3. **원자성**: 가스 차감·슬롯 기록·payer 설정·비용 징수·approve 플래그가 하나의 전이 —
   Phase 1.3.7의 approval-effects 저널을 사용해 이후 프레임 revert/atomic-batch 롤백에서
   **절대 되돌리지 않음**. (구현 전략: statedb 스냅샷 복원 후 approval effects 재적용,
   또는 별도 오버레이 — 재적용 방식 권장, 단순함)
4. keyed-nonce 읽기/쓰기는 EIP-2929 accessed set에 **넣지 않고** warm도 만들지 않음
   (프로토콜 북키핑 — statedb 직접 접근 경로 사용, EVM 경유 금지).
5. 가스 surcharge는 해당 프레임 `gas_used`/영수증/환불 계산에 포함.

### 2.4 geth: TXPARAM / framepool

- `TXPARAM(0x01)` = nonce_seq; 신규 0x0C–0x0F (0.4 표) 구현.
  `nonce_keys_hash = keccak(bytes32(len) || bytes32(k0) || ...)`.
- framepool: pending 키를 `(sender, nonce)` → `(sender, nonce_keys, nonce_seq)`로 확장.
  replacement는 동일 key set + fee bump. 기존 "sender당 1 pending" 정책은 유지
  (스펙이 완화를 요구하지 않음).
- `eth_getTransactionCount`는 legacy nonce 그대로.

### 2.5 viem

- types/serializer/parser에 `nonceKeys: bigint[]`, `nonceSeq: bigint` (기존 `nonce` 대체;
  API 하위호환: `nonce`만 주면 `nonceKeys=[0], nonceSeq=nonce`로 승격).
- `getKeyedNonce(client, sender, key)` 헬퍼: NONCE_MANAGER 슬롯 계산 후 `eth_getStorageAt`.
- `prepareFrameTransaction`: key 지정 시 seq 자동 조회.
- 테스트: 직렬화/서명 벡터, keyed tx e2e.

### 2.6 contracts / solidity / docs

- solidity: 변경 없음 (TXPARAM param 값만 추가 — 빌트인 재사용).
- `FrameTxLib`: `PARAM_NONCE_KEY_0(0x0C)` 등 상수 + `nonceKeysHash()` 래퍼 추가.
- 예제: `NullifierValidator.sol` — VERIFY에서
  `TXPARAM(0x0E)==N && TXPARAM(0x0F)==expectedKeysHash && TXPARAM(0x01)==0`을 검증하고
  approve하는 single-use key 패턴 (스펙 Security Considerations 준수 예시).
- docs: 8250 섹션 신설 (docs/eip-8250-keyed-nonces.md), overview에 페이로드 변경 반영.

### 2.7 Phase 2 인수 기준

- [x] `nonceKeys=[0]` tx가 Phase 1과 동일하게 동작 (legacy alias)
- [x] 서로 다른 non-zero key set의 두 tx가 같은 sender로 한 블록에 모두 포함됨
- [x] 같은 key 재사용 시 두 번째 tx invalid (replay 방지)
- [x] first-use 시 20000 gas surcharge가 receipt gas_used에 반영, 재사용 시 미부과
- [x] payment approve 후 후속 프레임 revert에도 keyed nonce 소비가 유지됨
- [x] NONCE_MANAGER 직접 호출이 revert

---

## Phase 3 — EIP-8272 (Recent Roots)

### 3.1 geth: 타입/디코딩

- `FrameTx`에 `RecentRootRefs []RecentRootRef` 추가 (`{SourceID [32]byte, Slot uint64, Root [32]byte}`),
  페이로드 11번째 필드.
- 정적 검증: 리스트 형식, 항목 3원소, source_id/root 32바이트, slot canonical uint64,
  `len <= 16`. sig hash에 포함(elide 안 함).

### 3.2 geth: SlotProvider + 시스템 컨트랙트

- `SlotProvider` 인터페이스 (0.6.2): devnet은 `timestamp/12`.
- `RECENT_ROOT_ADDRESS(0x…8272)` 네이티브 핸들러 (0.6.1):
  - calldata 정확히 64B(salt||root) && value==0 아니면 revert; static context에서 실패
  - `source_id = keccak(caller(20B) || salt)`; `i = S mod 8192`
  - `entry_hash = keccak(ENTRY_DOMAIN || source_id || u64be(S) || root)`
  - `storage_key = keccak(STORAGE_DOMAIN || source_id || u64be(i))`
  - `storage[storage_key] = entry_hash`; 반환 데이터 없음; 일반 EVM 가스 규칙
- 활성화 시 계정 생성 (balance 0, nonce 1, marker code).

### 3.3 geth: reference 검증 + 가스 + opcode

- **검증 시점**: nonce(keyed-nonce) 체크 직후, 프레임 실행 전, tx pre-state 대상:
  `1 <= current_slot - slot <= 8191` && `storage[storage_key] == entry_hash`.
  실패 시 tx invalid (블록 내 포함 시 블록 invalid).
- 유효 reference마다 `RECENT_ROOT_ADDRESS`+storage_key를 accessed set에 추가 (warm/cold만 영향).
- 가스: `tx_gas_limit`에 `refs>0 ? 2400 + len(refs)*2002 : 0` 추가
  (`2002 = 1900 + 2*30 + 7*6`), EIP-7623 calldata는 `rlp(frames)||rlp(refs)` 연접 1개 스트링으로 계산.
- `RECENTROOTREFLOAD(0xB5)`: gas 3, pop `field`(top), `index`;
  field 0=source_id, 1=slot(zero-extended), 2=root; OOB/field>2 → halt. 모든 모드 허용.
- `TXPARAM(0x10)` = `len(recent_root_references)`.

### 3.4 geth: framepool

- admission: 모든 ref가 현재 head 기준 유효해야 수용; `slot >= current_slot`인 ref 있으면 거부.
- recheck: head 변경/slot 진행/리오그 시 ref 재검증; `current_slot - slot >= 8192` 시 evict.

### 3.5 viem / contracts / solidity / docs

- viem: `recentRootReferences` 타입+직렬화+sig hash; 헬퍼
  `computeSourceId(address, salt)`, `writeRecentRoot(client, {salt, root})` (0x…8272 호출 tx),
  `makeRootReference(...)`.
- contracts: `FrameTxLib`에 `recentRootRefLoad(field, idx)` 래퍼;
  예제 `RootAnchoredValidator.sol` — VERIFY에서 RECENTROOTREFLOAD로 기대 `(source_id, slot, root)`
  튜플을 검증하는 privacy-style 패턴.
- solidity: `recentrootrefload(field, index)` 빌트인(0xB5) 추가.
- docs: 8272 문서 신설, opcode/TXPARAM 배정표(0.3/0.4) 문서화.

### 3.6 Phase 3 인수 기준

- [x] source가 slot S에 root 기록 → S+1부터 해당 ref를 단 tx 성공
- [x] 같은 slot(S) ref는 거부, 윈도우(8191) 초과 ref는 invalid
- [x] 잘못된 root/source_id ref → tx invalid
- [x] 같은 slot에 두 번 쓰면 마지막 write만 referenceable
- [x] RECENTROOTREFLOAD로 VERIFY 프레임에서 튜플 검증하는 e2e 통과
- [x] ref 포함 tx의 intrinsic gas 증가분이 공식과 일치

---

## 작업 순서·리스크 요약

1. **Phase 1이 전체의 ~70%.** 특히 1.1(타입)+1.3(실행)+1.4(opcode)는 서로 얽혀 있어
   한 브랜치에서 순차 진행 권장. 컴파일러(1.8)는 1.4와 병행 가능.
2. **스키마 변경 = 하위호환 파괴**: 각 Phase 경계에서 devnet 재생성, viem/geth 버전 짝 맞춤 필요.
3. **가장 까다로운 부분**:
   - approval-effects 저널 분리 (1.3.7, 2.3.3) — geth journal 구조와의 정합
   - framepool canonical paymaster 회계 (1.6.5) — 상태 추적 버그 나기 쉬움
   - 8272 current_slot (devnet에 CL 없음) — 근사 사용을 명시적으로 격리
4. **테스트 자산**: `.context/test-vectors/`에 sig hash·RLP 벡터를 두고 geth/viem이 공유.

---

## Phase 4 — Release closeout

완료일: 2026-07-12

- [x] Phase 1~3 구현 및 acceptance 체크리스트를 실제 테스트 결과와 동기화
- [x] 11-field transaction / 6-field frame canonical fixture를
  `.context/test-vectors/frame-transaction-v1.json`으로 단일화
- [x] geth, viem, contracts Phase 1/3 E2E가 동일 canonical fixture의 transaction,
  raw tx, sig hash, intrinsic gas를 소비; 독립 submodule 테스트용 generated snapshot은
  `scripts/sync-test-vectors.sh --check`로 byte-for-byte 동기화
- [x] `scripts/run-phase-e2e.sh`가 Phase 1/2/3을 각각 fresh devnet에서 실행
- [x] `.github/workflows/release-closeout.yml`에서 full build, geth/viem/contracts tests,
  Phase 1~3 acceptance를 재현
- [x] 모든 직접 submodule이 attached branch이며 부모 pointer와 원격 branch가 일치

Phase 4 시작 기준 커밋:

- parent `main`: `e9c502c`
- geth `sm-stack/eip8141-poc`: `fece10d0f`
- solidity `eip-8141`: `cd61b59b5`
- viem `8141-poc`: `b12e6b04`
