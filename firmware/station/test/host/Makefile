# Host unit tests for the station core (needs g++ and OpenSSL headers).
CXX ?= g++
CXXFLAGS ?= -std=c++11 -Wall -Wextra -Werror -O1

.PHONY: test clean
test: test_core
	./test_core

vectors.h: ../vectors.json gen_vectors.py
	python3 gen_vectors.py vectors.h

test_core: test_core.cpp vectors.h ../../src/station_core.h
	$(CXX) $(CXXFLAGS) test_core.cpp -o test_core -lcrypto

clean:
	rm -f test_core vectors.h
