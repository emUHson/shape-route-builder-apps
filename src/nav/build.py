"""Builds the Run Nav site into ../../nav: inlines the QR encoder and app.js into shell.html, copies the PWA files."""
import os, shutil
here=os.path.dirname(os.path.abspath(__file__)); out=os.path.join(here,'..','..','nav')
s=open(os.path.join(here,'shell.html')).read()
s=s.replace('/*QR*/',open(os.path.join(here,'qr.min.js')).read()).replace('/*APP*/',open(os.path.join(here,'app.js')).read())
os.makedirs(out,exist_ok=True); open(os.path.join(out,'index.html'),'w').write(s)
for f in ['manifest.webmanifest','sw.js','icon.svg','icon-192.png','icon-512.png']: shutil.copy(os.path.join(here,f),os.path.join(out,f))
print('built',os.path.normpath(out))
