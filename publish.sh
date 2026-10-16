cd /tmp
rm -rf /tmp/homebridge-orvibo-publish-1.1.3
mkdir -p /tmp/homebridge-orvibo-publish-1.1.3
unzip /tmp/homebridge-orvibo-cloud-1.1.3.zip -d /tmp/homebridge-orvibo-publish-1.1.3
cd /tmp/homebridge-orvibo-publish-1.1.3/homebridge-orvibo-cloud

cd /tmp

rm -rf /tmp/repo-upload

git clone https://github.com/Kosztyk/homebridge_orvibo_cloud.git /tmp/repo-upload

rsync -av --delete \
  --exclude='.git' \
  --exclude='.npmrc' \
  /tmp/homebridge-orvibo-publish-1.1.3/homebridge-orvibo-cloud/ \
  /tmp/repo-upload/

cd /tmp/repo-upload

git status
git add -A
git commit -m "Release 1.1.3 ORVIBO support"
git push origin main

git tag v1.1.3
git push origin v1.1.3

export PATH=/opt/homebridge/bin:$PATH
cd /tmp/repo-upload

npm pack --dry-run
npm whoami
npm publish

npm view homebridge-orvibo-cloud version
