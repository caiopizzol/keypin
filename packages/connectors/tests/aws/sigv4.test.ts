import { describe, expect, test } from "vite-plus/test";
import { signing } from "../../src/aws/sigv4";

const SUITE = "https://github.com/awslabs/aws-c-auth/tree/main/tests/aws-signing-test-suite/v4";
const CREDENTIALS = { id: "AKIDEXAMPLE", secret: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" };
const SCOPE = { region: "us-east-1", service: "service" };
const AT = new Date("2015-08-30T12:36:00Z");
const BODY_HASH = "9095672bbd1f56dfc5b65f3e153adc8731a4a654192329106275f4c7b24d0b6e";

describe(`AWS Signature Version 4, against AWS's test suite at ${SUITE}`, () => {
  test("post-vanilla", () => {
    const signed = signing(
      { method: "POST", url: "https://example.amazonaws.com/", headers: {}, body: "" },
      CREDENTIALS,
      SCOPE,
      AT,
    );
    expect(signed.canonicalRequest).toBe(
      "POST\n/\n\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(signed.stringToSign).toBe(
      "AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\n553f88c9e4d10fc9e109e2aeb65f030801b70c2f6468faca261d401ae622fc87",
    );
    expect(signed.headers.Authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5da7c1a2acd57cee7505fc6676e4e544621c30862966e37dddb68e92efbe5d6b",
    );
    expect(signed.headers["X-Amz-Date"]).toBe("20150830T123600Z");
  });

  test("get-vanilla-query-order-key-case", () => {
    const signed = signing(
      {
        method: "GET",
        url: "https://example.amazonaws.com/?Param2=value2&Param1=value1",
        headers: {},
        body: "",
      },
      CREDENTIALS,
      SCOPE,
      AT,
    );
    expect(signed.canonicalRequest.split("\n")[2]).toBe("Param1=value1&Param2=value2");
    expect(signed.signature).toBe(
      "b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500",
    );
  });

  test("post-x-www-form-urlencoded", () => {
    const signed = signing(
      {
        method: "POST",
        url: "https://example.amazonaws.com/",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": "13",
          "x-amz-content-sha256": BODY_HASH,
        },
        body: "Param1=value1",
      },
      CREDENTIALS,
      SCOPE,
      AT,
    );
    expect(signed.stringToSign.split("\n")[3]).toBe(
      "b1edd1d03544c25390e32085d55b57acc9a3961bb59415ff86c45c3d89d16cfb",
    );
    expect(signed.headers.Authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=content-length;content-type;host;x-amz-content-sha256;x-amz-date, Signature=d3875051da38690788ef43de4db0d8f280229d82040bfac253562e56c3f20e0b",
    );
  });

  test("post-x-www-form-urlencoded-parameters", () => {
    const signed = signing(
      {
        method: "POST",
        url: "https://example.amazonaws.com/",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
          "Content-Length": "13",
          "x-amz-content-sha256": BODY_HASH,
        },
        body: "Param1=value1",
      },
      CREDENTIALS,
      SCOPE,
      AT,
    );
    expect(signed.signature).toBe(
      "328d1b9eaadca9f5818ef05e8392801e091653bafec24fcab71e7344e7f51422",
    );
  });
});
