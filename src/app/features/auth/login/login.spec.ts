import { ComponentFixture, TestBed } from "@angular/core/testing";
import { ActivatedRoute, Router } from "@angular/router";
import { AuthService } from "../../../core/auth.service";
import LoginPage from "./login";

describe("LoginPage", () => {
  let component: LoginPage;
  let fixture: ComponentFixture<LoginPage>;

  const authMock = {
    login: jasmine.createSpy("login").and.resolveTo({}),
    getAccessStatus: jasmine
      .createSpy("getAccessStatus")
      .and.resolveTo({ uid: "uid-1", roleId: "admin", isActive: true, mustChangePassword: false }),
    logout: jasmine.createSpy("logout").and.resolveTo(undefined),
  };

  const routerMock = {
    navigateByUrl: jasmine.createSpy("navigateByUrl").and.resolveTo(true),
  };

  const routeMock = {
    snapshot: { queryParams: {} as Record<string, string> },
  };

  beforeEach(async () => {
    localStorage.clear();
    authMock.login.calls.reset();
    authMock.getAccessStatus.calls.reset();
    authMock.logout.calls.reset();
    routerMock.navigateByUrl.calls.reset();

    await TestBed.configureTestingModule({
      imports: [LoginPage],
      providers: [
        { provide: AuthService, useValue: authMock },
        { provide: Router, useValue: routerMock },
        { provide: ActivatedRoute, useValue: routeMock },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(LoginPage);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it("should create", () => {
    expect(component).toBeTruthy();
  });

  it("should restore remembered identifier", () => {
    localStorage.setItem("bm_login_remember_identifier", "1");
    localStorage.setItem("bm_login_saved_identifier", "admin@basemayorista.com");

    const secondFixture = TestBed.createComponent(LoginPage);
    const secondComponent = secondFixture.componentInstance;
    secondFixture.detectChanges();

    expect(secondComponent.rememberIdentifier).toBeTrue();
    expect(secondComponent.identifier).toBe("admin@basemayorista.com");
  });

  it("should toggle password visibility", () => {
    expect(component.showPassword).toBeFalse();
    component.togglePasswordVisibility();
    expect(component.showPassword).toBeTrue();
  });

  it("should not submit when identifier is invalid", async () => {
    component.identifier = "x";
    component.password = "123456";

    await component.onLogin();

    expect(component.hasIdentifierError()).toBeTrue();
    expect(authMock.login).not.toHaveBeenCalled();
  });

  it("should show identifier validation after touch", () => {
    component.identifier = "";
    component.markIdentifierTouched();

    expect(component.hasIdentifierError()).toBeTrue();
    expect(component.getIdentifierError()).toBe("El correo o usuario es obligatorio.");
  });

  it("should mark identifier as valid after touch with correct format", () => {
    component.identifier = "admin@basemayorista.com";
    component.markIdentifierTouched();

    expect(component.hasIdentifierValid()).toBeTrue();
    expect(component.hasIdentifierError()).toBeFalse();
  });
});
