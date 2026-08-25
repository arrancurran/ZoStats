NAME := zostats
VERSION := 1.0.4
XPI := dist/$(NAME)-$(VERSION).xpi
FILES := manifest.json bootstrap.js zostats.js locale icons LICENSE README.md

.PHONY: all package test verify clean

all: test package verify

package: $(XPI)

$(XPI): $(shell find $(FILES) -type f)
	mkdir -p dist
	(cd . && zip -X -r -9 "$(abspath $@)" $(FILES))
	xattr -c "$@" 2>/dev/null || true

test:
	node --check bootstrap.js
	node --check zostats.js
	node --test tests/zostats.test.js
	python3 -m json.tool manifest.json >/dev/null
	python3 -m json.tool updates.json >/dev/null

verify: $(XPI)
	unzip -t "$(XPI)" >/dev/null
	test "$$(jq -r '.addons["zostats@arrancurran.github.io"].updates[0].update_hash' updates.json)" = "sha256:$$(shasum -a 256 "$(XPI)" | cut -d' ' -f1)"

clean:
	rm -f "$(XPI)"
