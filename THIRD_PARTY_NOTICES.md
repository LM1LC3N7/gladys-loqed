# Third-party notices

This integration ports to JavaScript the LOQED bridge protocol as the
following project implements it: the signed command (layout, HMAC-SHA256 with
the local key), the TIMESTAMP and HASH headers of the webhook management, the
check of the webhooks the bridge sends, and how /status and the webhook bodies
are read (`src/loqed.js`). Nothing of it is installed at runtime; its notice
is reproduced as the BSD-2-Clause license asks.

The mapping of the lock states and the shape of the test fixtures also follow
Home Assistant's LOQED integration (`homeassistant/components/loqed` and its
tests, Apache-2.0), read, not copied.

## loqedAPI

<https://github.com/cpolhout/loqedAPI> (version 2.1.18 on PyPI, 2026-10-12)

```
BSD 2-Clause License

Copyright (c) 2017, pyexample
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

* Redistributions of source code must retain the above copyright notice, this
  list of conditions and the following disclaimer.

* Redistributions in binary form must reproduce the above copyright notice,
  this list of conditions and the following disclaimer in the documentation
  and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```
