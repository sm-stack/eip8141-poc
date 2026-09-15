#!/usr/bin/env python3
"""Check lane arithmetic independently against the digit-by-digit definition."""
import random
import unittest
class Reductions(unittest.TestCase):
 def test_sum(self):
  rng=random.Random(8141)
  for d in [0,(1<<256)-1,*[1<<i for i in range(256)],*[rng.getrandbits(256) for _ in range(10000)]]:
   expected=sum((d>>(3*i))&7 for i in range(43))
   v=d&((1<<129)-1)
   for w in (3,6,12,24,48,96):
    mask=sum(((1<<w)-1)<<i for i in range(0,256,2*w))&((1<<256)-1)
    v=(v&mask)+((v>>w)&mask)
   self.assertEqual(v,expected)
if __name__=='__main__': unittest.main()
