.PHONY: build build-geth build-solc submodules clean \
       contracts test devnet send-frame-tx send-kernel-tx send-hooked-tx

BUILD_DIR := $(CURDIR)/build
GETH_BIN := $(BUILD_DIR)/bin/geth
SOLC_BIN := $(BUILD_DIR)/bin/solc

build: submodules build-geth build-solc
	@echo "Build complete."
	@echo "  geth: $(GETH_BIN)"
	@echo "  solc: $(SOLC_BIN)"

submodules:
	git submodule update --init --recursive

build-geth:
	$(MAKE) -C 8141-geth geth
	@mkdir -p $(BUILD_DIR)/bin
	cp 8141-geth/build/bin/geth $(GETH_BIN)

build-solc:
	@mkdir -p $(BUILD_DIR)/solc
	cd $(BUILD_DIR)/solc && cmake $(CURDIR)/solidity-eip8141 -DCMAKE_BUILD_TYPE=Release
	$(MAKE) -C $(BUILD_DIR)/solc solc
	@mkdir -p $(BUILD_DIR)/bin
	cp $(BUILD_DIR)/solc/solc/solc $(SOLC_BIN)

contracts:
	cd contracts && forge build

test:
	cd contracts && forge test -vv

devnet:
	bash devnet/run.sh

send-frame-tx:
	cd contracts && npx tsx script/send_frame_tx.ts

send-kernel-tx:
	cd contracts && npx tsx script/send_kernel_tx.ts

send-hooked-tx:
	cd contracts && npx tsx script/send_hooked_tx.ts

clean:
	rm -rf $(BUILD_DIR)
	$(MAKE) -C 8141-geth clean
