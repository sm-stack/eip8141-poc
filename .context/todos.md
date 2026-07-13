# EIP-8141/8250/8272 작업 목록

> 상세 계획: [implementation-plan.md](./implementation-plan.md) — 섹션 번호(§)는 그 문서 기준.
> 감사 결과 요약: 전 스택이 구버전 8141 드래프트 기준. 8250/8272는 전면 미구현.

## Phase 0 — 결정 사항 확정 (§0)

- [x] 통합 페이로드 순서 확정 (§0.1)
- [x] sig hash 규칙: empty-msg 서명 raw bytes elision (§0.2)
- [x] opcode 배정: SIGPARAM=0xB4 유지, RECENTROOTREFLOAD→0xB5 (§0.3)
- [x] TXPARAM 인덱스 배정: 8250→0x0C–0x0F, 8272 count→0x10 (§0.4)
- [x] 시스템 컨트랙트 주소: NONCE_MANAGER=0x…8250, RECENT_ROOT=0x…8272 (§0.5)
- [x] 8272 RECENT_ROOT_CODE 네이티브 구현 + SlotProvider(devnet: ts/12) (§0.6)
- [x] 위 결정 사항 팀 리뷰/승인 (2026-07-05 harry 승인)

## Phase 1 — EIP-8141 현행화

### geth (8141-geth)
- [x] §1.1 `TxSignature` 타입 + `Frame.Flags/Value` + `FrameTx.Signatures` + RLP (core/types/tx_frame.go)
- [x] §1.1 디코드 정적 제약 (MAX_FRAMES=64, value/SENDER, atomic-batch-not-last, 서명 형식, expiry frame 제약)
- [x] §1.1 sig hash 재구현 (empty-msg raw bytes elision) + test vector export
- [x] §1.1 receipt status 재정의 (0/1/3=skipped, approve 2/3/4 제거)
- [x] §1.2 tx-level 서명 검증 (secp256k1 ecrecover, P256, 가스 2800/6700)
- [x] §1.3 SENDER frame value 전송
- [x] §1.3 APPROVE 비트마스크 시맨틱 재작성 (PAYMENT=1, EXECUTION=2, BOTH=3; frame.flags 허용 검사)
- [x] §1.3 atomic batch (snapshot/rollback/skip/gas 환불)
- [x] §1.3 expiry verifier predeploy(0x…8141) + TIMESTAMP 예외
- [x] §1.3 default code를 tx.signatures 기반으로 갱신
- [x] §1.3 프레임 간 TSTORE/TLOAD 폐기 확인
- [x] §1.3.7 approval-effects 저널 분리 (8250 선행 구조)
- [x] §1.4 opcode 재편: TXPARAM/FRAMEDATALOAD/FRAMEDATACOPY/FRAMEPARAM/SIGPARAM (0xB0–0xB4)
- [x] §1.5 가스: 475/frame + rlp(signatures) calldata + sig gas; 환불 로직
- [x] §1.6 framepool: 서명 선검증, expiry skip/drop, prefix 배치금지, canonical paymaster 회계, non-canonical ≤1
- [x] §1.7 RPC 직렬화 (flags/value/signatures, receipt payer/status)

### solidity-eip8141
- [x] §1.8 opcode 5개 체계 등록 + GasMeter/SemanticInformation + Yul 빌트인

### contracts
- [x] §1.9 FrameTxLib 개정 (scope 비트마스크, PARAM 0x00–0x0B, 신규 래퍼)
- [x] §1.9 전 계정/페이마스터/테스트헬퍼 scope 마이그레이션
- [x] §1.9 Simple8141Account → tx.signatures + SIGPARAM 예제 전환
- [x] §1.9 CanonicalPaymaster (timelocked withdrawal) 신설, 코드 해시 고정
- [x] §1.9 atomic batch / value / expiry / P256 예제 + forge 테스트

### viem-eip8141
- [x] §1.10 types/serializer/parser: 9필드, frame 6필드, signatures
- [x] §1.10 computeSigHash 교체 + geth 교차 벡터
- [x] §1.10 EOA flow: signatures 리스트 + flags 기반 scope
- [x] §1.10 가스 추정 공식 구현
- [x] §1.10 receipt status 0/1/3, expiry/atomic-batch 헬퍼

### 마무리
- [x] §1.11 docs 전면 갱신 (MAX_FRAMES 64, opcode 체계, 가스, scope 등)
- [x] §1.12 e2e 인수 기준 7항목 통과

## Phase 2 — EIP-8250 (Keyed Nonces)

- [x] §2.1 geth: nonce → nonce_keys/nonce_seq + 디코더 규칙
- [x] §2.2 geth: NONCE_MANAGER predeploy + 슬롯 유도 + stateful validity
- [x] §2.3 geth: payment APPROVE 내 consume_nonce_set + first-use 20000 gas + 저널 비가역성 + 2929 비적용
- [x] §2.4 geth: TXPARAM 0x01/0x0C–0x0F + framepool 키 확장
- [x] §2.5 viem: nonceKeys/nonceSeq + getKeyedNonce 헬퍼
- [x] §2.6 contracts: FrameTxLib 상수 + NullifierValidator 예제; docs
- [x] §2.7 e2e 인수 기준 6항목 통과

## Phase 3 — EIP-8272 (Recent Roots)

- [x] §3.1 geth: recent_root_references 필드 + 정적 검증
- [x] §3.2 geth: SlotProvider + RECENT_ROOT 네이티브 컨트랙트
- [x] §3.3 geth: pre-execution ref 검증 + accessed set + 가스(2400/2002) + RECENTROOTREFLOAD(0xB5) + TXPARAM 0x10
- [x] §3.4 geth: framepool admission/recheck/evict
- [x] §3.5 viem 헬퍼 + contracts RootAnchoredValidator + solidity 빌트인 + docs
- [x] §3.6 e2e 인수 기준 6항목 통과

## Phase 4 — Release closeout

- [x] Phase 1~3 계획/체크리스트와 실제 구현 상태 동기화
- [x] `.context/test-vectors` canonical fixture와 검증된 submodule snapshots로 geth/viem/contracts 통합
- [x] fresh devnet Phase 1/2/3 runner 추가
- [x] full build/test/E2E GitHub Actions workflow 추가
- [x] submodule branch/pointer/remote 정합성 감사
