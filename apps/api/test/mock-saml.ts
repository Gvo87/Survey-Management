/**
 * A test SAML identity provider: a self-signed certificate and signed responses to the service provider's
 * AuthnRequest, as Okta or Entra ID would POST them. A check against a real provider needs an account there.
 */
import { randomBytes } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { generate } from 'selfsigned';
import { SignedXml } from 'xml-crypto';

export const IDP_ISSUER = 'https://idp.example.test/saml';
export const IDP_ENTRY_POINT = 'https://idp.example.test/sso';

export async function createMockSaml() {
  const pems = await generate([{ name: 'commonName', value: 'idp.example.test' }], { keySize: 2048, algorithm: 'sha256', notAfterDate: new Date(Date.now() + 30 * 86_400_000) });
  return {
    cert: pems.cert,
    privateKey: pems.private,
    /** The AuthnRequest ID inside a redirect-binding URL (to answer it). */
    requestIdFrom(location: string): { id: string; relayState: string; acs: string } {
      const url = new URL(location);
      const xml = inflateRawSync(Buffer.from(url.searchParams.get('SAMLRequest') ?? '', 'base64')).toString('utf8');
      return {
        id: /\sID="([^"]+)"/.exec(xml)?.[1] ?? '',
        relayState: url.searchParams.get('RelayState') ?? '',
        acs: /AssertionConsumerServiceURL="([^"]+)"/.exec(xml)?.[1] ?? '',
      };
    },
    response(input: {
      inResponseTo: string;
      acsUrl: string;
      audience: string;
      email: string;
      name?: string;
      issuer?: string;
      sign?: boolean;
      signingKey?: string;
      signingCert?: string;
    }): string {
      const now = new Date();
      const later = new Date(now.getTime() + 5 * 60_000).toISOString();
      const assertionId = `_a${randomBytes(12).toString('hex')}`;
      const issuer = input.issuer ?? IDP_ISSUER;
      const xml = `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_r${randomBytes(12).toString('hex')}" Version="2.0" IssueInstant="${now.toISOString()}" Destination="${input.acsUrl}" InResponseTo="${input.inResponseTo}"><saml:Issuer>${issuer}</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status><saml:Assertion ID="${assertionId}" Version="2.0" IssueInstant="${now.toISOString()}"><saml:Issuer>${issuer}</saml:Issuer><saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${input.email}</saml:NameID><saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData NotOnOrAfter="${later}" Recipient="${input.acsUrl}" InResponseTo="${input.inResponseTo}"/></saml:SubjectConfirmation></saml:Subject><saml:Conditions NotBefore="${new Date(now.getTime() - 60_000).toISOString()}" NotOnOrAfter="${later}"><saml:AudienceRestriction><saml:Audience>${input.audience}</saml:Audience></saml:AudienceRestriction></saml:Conditions><saml:AuthnStatement AuthnInstant="${now.toISOString()}" SessionIndex="_s${randomBytes(6).toString('hex')}"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement><saml:AttributeStatement><saml:Attribute Name="email"><saml:AttributeValue>${input.email}</saml:AttributeValue></saml:Attribute><saml:Attribute Name="displayName"><saml:AttributeValue>${input.name ?? 'Sam L'}</saml:AttributeValue></saml:Attribute></saml:AttributeStatement></saml:Assertion></samlp:Response>`;
      if (input.sign === false) return Buffer.from(xml).toString('base64');
      const signer = new SignedXml({
        privateKey: input.signingKey ?? pems.private,
        publicCert: input.signingCert ?? pems.cert,
        signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
        canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#',
      });
      signer.addReference({
        xpath: "//*[local-name(.)='Assertion']",
        transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature', 'http://www.w3.org/2001/10/xml-exc-c14n#'],
        digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
      });
      signer.computeSignature(xml, { location: { reference: "//*[local-name(.)='Assertion']/*[local-name(.)='Issuer']", action: 'after' } });
      return Buffer.from(signer.getSignedXml()).toString('base64');
    },
  };
}
