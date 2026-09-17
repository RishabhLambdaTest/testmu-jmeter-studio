# Reproducing the comparison

The numbers in [../COMPARISON.md](../COMPARISON.md) come from these three
scripts. They are here so the claims can be checked, and disputed.

```bash
python3 make_har.py                 # synthetic.har + answers.json
# author synthetic.har in the extension, download it as ours.jmx
# put the same file through converter.blazemeter.com, save it as bzm.jmx
python3 score.py .                  # scores both against the answer key

python3 mock_shop.py 8111           # the live server, as recorded
python3 mock_shop.py 8111 drift     # the same app one release later
```

`score.py` reads the XML rather than trusting anything a plan reports. A case
counts as correlated only when the recorded value is gone from every later
request, a `${VAR}` stands where it was, an extractor defines that variable, and
that extractor's expression really finds the value in the recorded response.

`mock_shop.py` issues fresh values on every run and answers 4xx with the reason
whenever a stale one arrives, so a plan passes only if it genuinely correlates.
Point both plans at `127.0.0.1` before running them, and check that they are
pointed there: a plan still aimed at the recorded host will send load to a real
server.
