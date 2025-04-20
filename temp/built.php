<?php
$phar = new Phar('test.phar');
$phar->buildFromDirectory('src/');  // This does the thing you actually want.
