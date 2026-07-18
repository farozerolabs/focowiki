import { createServer } from "node:http";

const port = Number(process.env.S3_HEALTH_FIXTURE_PORT ?? 43300);
const server = createServer((request, response) => {
  if (request.method !== "GET") {
    response.writeHead(405).end();
    return;
  }

  response.writeHead(200, { "content-type": "application/xml" });
  response.end(
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>" +
      "<ListBucketResult xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\">" +
      "<Name>focowiki</Name><Prefix></Prefix><KeyCount>0</KeyCount>" +
      "<MaxKeys>1</MaxKeys><IsTruncated>false</IsTruncated></ListBucketResult>"
  );
});

server.listen(port, "127.0.0.1");

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
